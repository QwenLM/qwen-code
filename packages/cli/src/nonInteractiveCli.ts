/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ToolCallRequestInfo } from '@qwen-code/qwen-code-core';
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

    const stdoutErrorHandler = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        process.stdout.removeListener('error', stdoutErrorHandler);
        process.exit(0);
      }
    };

    const geminiClient = config.getGeminiClient();
    const abortController = options.abortController ?? new AbortController();

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
    // Track the approval listener so we can remove it in
    // finally — prevents duplicate handlers across turns in
    // multi-turn stream-json sessions.
    let approvalListener:
      | ((
          event: import('@qwen-code/qwen-code-core').TeammateApprovalRequestEvent,
        ) => void)
      | null = null;
    let approvalListenerManager:
      | import('@qwen-code/qwen-code-core').TeamManager
      | null = null;
    const onTeamManagerChangeHandler = (
      manager: import('@qwen-code/qwen-code-core').TeamManager | null,
    ) => {
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
          approvalListenerManager = manager;
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

      let isFirstTurn = true;
      let hasUnsentToolResponse = false;
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
          handleMaxTurnsExceededError(config);
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
          { type: sendType },
        );
        isFirstTurn = false;

        // Start assistant message for this turn
        adapter.startAssistantMessage();

        for await (const event of responseStream) {
          if (abortController.signal.aborted) {
            handleCancellationError(config);
          }
          // Use adapter for all event processing
          adapter.processEvent(event);
          if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
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

            // Note: In JSON mode, subagent messages are automatically added to the main
            // adapter's messages array and will be output together on emitResult()

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
            handleCancellationError(config);
          }

          // Also drain any final teammate messages.
          if (pendingTeammateMessages.length > 0) {
            continue;
          }

          // Check if cron jobs are keeping us alive
          const scheduler = !config.isCronEnabled()
            ? null
            : config.getCronScheduler();
          if (scheduler && scheduler.size > 0) {
            // Start the scheduler and wait for all jobs to complete or be deleted.
            // Each fired prompt is processed as a new turn through the same loop.
            await new Promise<void>((resolve) => {
              const cronQueue: string[] = [];
              let processing = false;

              const checkDone = () => {
                if (scheduler.size === 0 && !processing) {
                  scheduler.stop();
                  resolve();
                }
              };

              const drainQueue = async () => {
                if (processing) return;
                processing = true;
                try {
                  while (cronQueue.length > 0) {
                    const cronPrompt = cronQueue.shift()!;
                    turnCount++;
                    let cronMessages: Content[] = [
                      { role: 'user', parts: [{ text: cronPrompt }] },
                    ];
                    let cronIsFirstTurn = true;

                    while (true) {
                      const cronToolCallRequests: ToolCallRequestInfo[] = [];
                      const cronApiStartTime = Date.now();
                      const cronStream = geminiClient.sendMessageStream(
                        cronMessages[0]?.parts || [],
                        abortController.signal,
                        prompt_id,
                        {
                          type: cronIsFirstTurn
                            ? SendMessageType.Cron
                            : SendMessageType.ToolResult,
                        },
                      );
                      cronIsFirstTurn = false;

                      adapter.startAssistantMessage();

                      for await (const event of cronStream) {
                        if (abortController.signal.aborted) {
                          const summary = scheduler.getExitSummary();
                          scheduler.stop();
                          if (summary) {
                            process.stderr.write(summary + '\n');
                          }
                          resolve();
                          return;
                        }
                        adapter.processEvent(event);
                        if (event.type === GeminiEventType.ToolCallRequest) {
                          cronToolCallRequests.push(event.value);
                        }
                      }

                      adapter.finalizeAssistantMessage();
                      totalApiDurationMs += Date.now() - cronApiStartTime;

                      if (cronToolCallRequests.length > 0) {
                        const cronToolResponseParts: Part[] = [];

                        for (const requestInfo of cronToolCallRequests) {
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
                            { outputUpdateHandler },
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
                            cronToolResponseParts.push(
                              ...toolResponse.responseParts,
                            );
                          }
                        }
                        cronMessages = [
                          { role: 'user', parts: cronToolResponseParts },
                        ];
                      } else {
                        break;
                      }
                    }
                  }
                } catch (error) {
                  debugLogger.error('Error processing cron prompt:', error);
                } finally {
                  processing = false;
                  checkDone();
                }
              };

              scheduler.start((job: { prompt: string }) => {
                cronQueue.push(job.prompt);
                void drainQueue();
              });

              // Also check immediately in case jobs were already deleted
              checkDone();
            });
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
      handleError(error, config);
    } finally {
      // Unsubscribe the leader message callback, but do NOT tear
      // down the team itself — in stream-json sessions the same
      // Config is reused across turns, so the team must survive.
      // Full team cleanup happens via Config.shutdown() /
      // cleanupTeamRuntime() when the session ends.
      config.onTeamManagerChange(null, onTeamManagerChangeHandler);

      // Remove the per-turn approval listener from the
      // persistent TeamManager to avoid duplicates.
      if (approvalListener && approvalListenerManager) {
        approvalListenerManager
          .getEventEmitter()
          .off(TeamEventType.TEAMMATE_APPROVAL_REQUEST, approvalListener);
        approvalListener = null;
        approvalListenerManager = null;
      }

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
