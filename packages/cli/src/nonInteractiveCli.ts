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
  uiTelemetryService,
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
import {
  normalizePartList,
  extractPartsFromUserMessage,
  buildSystemMessage,
  createTaskToolProgressHandler,
  computeUsageFromMetrics,
} from './utils/nonInteractiveHelpers.js';

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
    let adapter: JsonOutputAdapterInterface | undefined;
    const outputFormat = config.getOutputFormat();

    if (options.adapter) {
      adapter = options.adapter;
    } else if (outputFormat === OutputFormat.JSON) {
      adapter = new JsonOutputAdapter(config);
    } else if (outputFormat === OutputFormat.STREAM_JSON) {
      adapter = new StreamJsonOutputAdapter(
        config,
        config.getIncludePartialMessages(),
      );
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
      if (config.getDebugMode()) {
        console.error('[runNonInteractive] Shutdown signal received');
      }
      abortController.abort();
    };

    try {
      process.stdout.on('error', stdoutErrorHandler);

      process.on('SIGINT', shutdownHandler);
      process.on('SIGTERM', shutdownHandler);

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
          if (slashCommandResult) {
            // A slash command can replace the prompt entirely; fall back to @-command processing otherwise.
            initialPartList = slashCommandResult as PartListUnion;
            slashHandled = true;
          }
        }

        if (!slashHandled) {
          const { processedQuery, shouldProceed } = await handleAtCommand({
            query: input,
            config,
            addItem: (_item, _timestamp) => 0,
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

      if (adapter) {
        const systemMessage = await buildSystemMessage(
          config,
          sessionId,
          permissionMode,
        );
        adapter.emitMessage(systemMessage);
      }

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
        );

        // Start assistant message for this turn
        if (adapter) {
          adapter.startAssistantMessage();
        }

        for await (const event of responseStream) {
          if (abortController.signal.aborted) {
            handleCancellationError(config);
          }

          if (adapter) {
            // Use adapter for all event processing
            adapter.processEvent(event);
            if (event.type === GeminiEventType.ToolCallRequest) {
              toolCallRequests.push(event.value);
            }
          } else {
            // Text output mode - direct stdout
            if (event.type === GeminiEventType.Content) {
              process.stdout.write(event.value);
            } else if (event.type === GeminiEventType.ToolCallRequest) {
              toolCallRequests.push(event.value);
            }
          }
        }

        // Finalize assistant message
        if (adapter) {
          adapter.finalizeAssistantMessage();
        }
        totalApiDurationMs += Date.now() - apiStartTime;

        if (toolCallRequests.length > 0) {
          const toolResponseParts: Part[] = [];

          for (const requestInfo of toolCallRequests) {
            const finalRequestInfo = requestInfo;

            /*
            if (options.controlService) {
              const permissionResult =
                await options.controlService.permission.shouldAllowTool(
                  requestInfo,
                );
              if (!permissionResult.allowed) {
                if (config.getDebugMode()) {
                  console.error(
                    `[runNonInteractive] Tool execution denied: ${requestInfo.name}`,
                    permissionResult.message ?? '',
                  );
                }
                if (adapter && permissionResult.message) {
                  adapter.emitSystemMessage('tool_denied', {
                    tool: requestInfo.name,
                    message: permissionResult.message,
                  });
                }
                continue;
              }

              if (permissionResult.updatedArgs) {
                finalRequestInfo = {
                  ...requestInfo,
                  args: permissionResult.updatedArgs,
                };
              }
            }

            const toolCallUpdateCallback = options.controlService
              ? options.controlService.permission.getToolCallUpdateCallback()
              : undefined;
            */

            // Only pass outputUpdateHandler for Task tool
            const isTaskTool = finalRequestInfo.name === 'task';
            const taskToolProgress = isTaskTool
              ? createTaskToolProgressHandler(
                  config,
                  finalRequestInfo.callId,
                  adapter,
                )
              : undefined;
            const taskToolProgressHandler = taskToolProgress?.handler;
            const toolResponse = await executeToolCall(
              config,
              finalRequestInfo,
              abortController.signal,
              isTaskTool && taskToolProgressHandler
                ? {
                    outputUpdateHandler: taskToolProgressHandler,
                    /*
                    toolCallUpdateCallback
                      ? { onToolCallsUpdate: toolCallUpdateCallback }
                      : undefined,
                    */
                  }
                : undefined,
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
              // Note: We no longer emit a separate system message for tool errors
              // in JSON/STREAM_JSON mode, as the error is already captured in the
              // tool_result block with is_error=true.
            }

            if (adapter) {
              adapter.emitToolResult(finalRequestInfo, toolResponse);
            }

            if (toolResponse.responseParts) {
              toolResponseParts.push(...toolResponse.responseParts);
            }
          }
          currentMessages = [{ role: 'user', parts: toolResponseParts }];
        } else {
          // For JSON and STREAM_JSON modes, compute usage from metrics
          if (adapter) {
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
          } else {
            // Text output mode - no usage needed
            process.stdout.write('\n');
          }
          return;
        }
      }
    } catch (error) {
      // For JSON and STREAM_JSON modes, compute usage from metrics
      const message = error instanceof Error ? error.message : String(error);
      if (adapter) {
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
      }
      handleError(error, config);
    } finally {
      process.stdout.removeListener('error', stdoutErrorHandler);
      // Cleanup signal handlers
      process.removeListener('SIGINT', shutdownHandler);
      process.removeListener('SIGTERM', shutdownHandler);
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry(config);
      }
    }
  });
}
