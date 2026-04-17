/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BackgroundAgentStatus,
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
  uiTelemetryService,
  parseAndFormatApiError,
  createDebugLogger,
  SendMessageType,
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

    try {
      process.stdout.on('error', stdoutErrorHandler);

      process.on('SIGINT', shutdownHandler);
      process.on('SIGTERM', shutdownHandler);

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

      // ─── Shared notification queue (cron + background agents) ──────
      // Register the callback early so background agents launched during
      // the main tool-call chain can push completions onto the queue.
      interface LocalQueueItem {
        displayText: string;
        modelText: string;
        sendMessageType: SendMessageType;
        sdkNotification?: {
          task_id: string;
          status: BackgroundAgentStatus;
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
          description: entry.description,
          subagent_type: entry.subagentType,
        });
      });

      let isFirstTurn = true;
      let modelOverride: string | undefined;
      while (true) {
        turnCount++;
        if (
          config.getMaxSessionTurns() >= 0 &&
          turnCount > config.getMaxSessionTurns()
        ) {
          handleMaxTurnsExceededError(config);
        }

        const toolCallRequests: ToolCallRequestInfo[] = [];
        const apiStartTime = Date.now();
        const responseStream = geminiClient.sendMessageStream(
          currentMessages[0]?.parts || [],
          abortController.signal,
          prompt_id,
          {
            type: isFirstTurn
              ? SendMessageType.UserQuery
              : SendMessageType.ToolResult,
            modelOverride,
          },
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

            // Capture model override from skill tool results.
            // Use `in` so that undefined (from inherit/no-model skills) clears a prior override,
            // while non-skill tools (field absent) leave the current override intact.
            if ('modelOverride' in toolResponse) {
              modelOverride = toolResponse.modelOverride;
            }
          }
          currentMessages = [{ role: 'user', parts: toolResponseParts }];
        } else {
          // No more tool calls — drain notifications and cron, then exit.

          // Process one queue item through the full turn loop.
          const drainOneItem = async () => {
            if (localQueue.length === 0) return;
            const item = localQueue.shift()!;

            if (item.sendMessageType === SendMessageType.Notification) {
              adapter.emitUserMessage([{ text: item.displayText }]);
              if (item.sdkNotification) {
                adapter.emitSystemMessage(
                  'task_notification',
                  item.sdkNotification,
                );
              }
            }

            turnCount++;
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
                  return;
                }
                adapter.processEvent(event);
                if (event.type === GeminiEventType.ToolCallRequest) {
                  itemToolCallRequests.push(event.value);
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

          // Single-flight drain: concurrent callers wait for the running
          // drain. A new drain starts only after the previous one finishes
          // its queue, which prevents overlapping turns when cron jobs fire
          // while an earlier queued item is still streaming.
          let drainPromise: Promise<void> | null = null;
          const drainLocalQueue = (): Promise<void> => {
            if (drainPromise) return drainPromise;
            drainPromise = (async () => {
              try {
                while (localQueue.length > 0) {
                  await drainOneItem();
                }
              } finally {
                drainPromise = null;
              }
            })();
            return drainPromise;
          };

          // Start cron scheduler — fires enqueue onto the shared queue.
          const scheduler = !config.isCronEnabled()
            ? null
            : config.getCronScheduler();

          if (scheduler && scheduler.size > 0) {
            await new Promise<void>((resolve) => {
              const checkCronDone = () => {
                if (scheduler.size === 0 && !drainPromise) {
                  scheduler.stop();
                  resolve();
                }
              };

              scheduler.start((job: { prompt: string }) => {
                const label = job.prompt.slice(0, 40);
                localQueue.push({
                  displayText: `Cron: ${label}`,
                  modelText: job.prompt,
                  sendMessageType: SendMessageType.Cron,
                });
                void drainLocalQueue().then(checkCronDone);
              });

              // Check immediately in case jobs were already deleted
              checkCronDone();
            });
          }

          // ─── Terminal hold-back phase ──────────────────────────
          // Wait for running background agents to complete and drain
          // their notifications before emitting the final result.

          while (true) {
            await drainLocalQueue();
            const running = registry.getRunning();
            if (running.length === 0 && localQueue.length === 0) break;
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
      handleError(error, config);
    } finally {
      try {
        const reg = config.getBackgroundTaskRegistry();
        reg.setNotificationCallback(undefined);
        reg.setRegisterCallback(undefined);
      } catch {
        // Ignore — registry may not be initialized if we failed early.
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
