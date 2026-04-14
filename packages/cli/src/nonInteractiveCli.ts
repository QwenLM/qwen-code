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
  createToolProgressHandler,
  createAgentToolProgressHandler,
  computeUsageFromMetrics,
} from './utils/nonInteractiveHelpers.js';
import { TurnBuffer } from './acp-integration/session/rewrite/TurnBuffer.js';
import { LlmRewriter } from './acp-integration/session/rewrite/LlmRewriter.js';
import { loadRewriteConfig } from './acp-integration/session/rewrite/config.js';

const debugLogger = createDebugLogger('NON_INTERACTIVE_CLI');

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

      // Initialize message rewriter if configured
      const rewriteConfig = loadRewriteConfig(settings);
      const rewriter = rewriteConfig?.enabled
        ? new LlmRewriter(config, rewriteConfig)
        : null;
      const rewriteTarget = rewriteConfig?.target ?? 'both';
      const turnBuffer = rewriter ? new TurnBuffer() : null;
      let rewriteTurnIndex = 0;
      const pendingRewrites: Array<
        Promise<{ turnIdx: number; text: string } | null>
      > = [];

      /**
       * Emit all settled rewrite results via the adapter.
       * Must be called from the main control flow (not inside async promises)
       * to avoid concurrent adapter state corruption.
       */
      const emitSettledRewrites = async () => {
        if (pendingRewrites.length === 0) return;
        const results = await Promise.allSettled(pendingRewrites);
        pendingRewrites.length = 0;
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            adapter.startAssistantMessage();
            adapter.processEvent({
              type: GeminiEventType.Content,
              value: r.value.text,
              _meta: { rewritten: true, turnIndex: r.value.turnIdx },
            } as unknown as Parameters<
              JsonOutputAdapterInterface['processEvent']
            >[0]);
            adapter.finalizeAssistantMessage();
          }
        }
      };

      if (rewriter) {
        debugLogger.info('Message rewrite enabled in non-interactive mode');
      }

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

        // Emit any settled rewrites before starting the next turn
        await emitSettledRewrites();

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

          // Accumulate for turn-end rewriting (respecting target filter)
          if (turnBuffer) {
            if (
              event.type === GeminiEventType.Content &&
              typeof event.value === 'string' &&
              (rewriteTarget === 'message' || rewriteTarget === 'both')
            ) {
              turnBuffer.appendMessage(event.value);
            } else if (
              event.type === GeminiEventType.Thought &&
              event.value &&
              (rewriteTarget === 'thought' || rewriteTarget === 'both')
            ) {
              const thought = event.value;
              const thoughtText = thought.subject
                ? `${thought.subject}: ${thought.description}`
                : thought.description;
              if (thoughtText) turnBuffer.appendThought(thoughtText);
            }
          }

          if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
            if (turnBuffer) turnBuffer.markToolCall();
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

        // Rewrite turn content (async, parallel with tool execution).
        // Only collects rewritten text — emission happens at safe boundaries
        // via emitSettledRewrites() to avoid concurrent adapter state corruption.
        if (rewriter && turnBuffer) {
          const content = turnBuffer.flush();
          if (content) {
            rewriteTurnIndex++;
            const turnIdx = rewriteTurnIndex;
            pendingRewrites.push(
              (async () => {
                try {
                  const rewriteSignal = AbortSignal.any([
                    abortController.signal,
                    AbortSignal.timeout(30_000),
                  ]);
                  const rewritten = await rewriter.rewrite(
                    content,
                    rewriteSignal,
                  );
                  if (rewritten) {
                    debugLogger.info(
                      `Turn ${turnIdx}: rewritten ${rewritten.length} chars`,
                    );
                    return { turnIdx, text: rewritten };
                  }
                } catch (err) {
                  debugLogger.warn(
                    `Turn ${turnIdx}: rewrite failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                return null;
              })(),
            );
          }
        }

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
          // No more tool calls — check if cron jobs are keeping us alive
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
                    let cronModelOverride: string | undefined;

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
                          modelOverride: cronModelOverride,
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

                        // Accumulate turn content for rewriting (respecting target filter)
                        if (turnBuffer) {
                          if (
                            event.type === GeminiEventType.Content &&
                            typeof event.value === 'string' &&
                            (rewriteTarget === 'message' ||
                              rewriteTarget === 'both')
                          ) {
                            turnBuffer.appendMessage(event.value);
                          } else if (
                            event.type === GeminiEventType.Thought &&
                            event.value &&
                            (rewriteTarget === 'thought' ||
                              rewriteTarget === 'both')
                          ) {
                            const thought = event.value;
                            const thoughtText = thought.subject
                              ? `${thought.subject}: ${thought.description}`
                              : thought.description;
                            if (thoughtText)
                              turnBuffer.appendThought(thoughtText);
                          }
                        }

                        if (event.type === GeminiEventType.ToolCallRequest) {
                          cronToolCallRequests.push(event.value);
                          if (turnBuffer) turnBuffer.markToolCall();
                        }
                      }

                      adapter.finalizeAssistantMessage();
                      totalApiDurationMs += Date.now() - cronApiStartTime;

                      // Flush turn buffer and rewrite for cron path (async, collect only)
                      if (rewriter && turnBuffer) {
                        const content = turnBuffer.flush();
                        if (content) {
                          rewriteTurnIndex++;
                          const turnIdx = rewriteTurnIndex;
                          pendingRewrites.push(
                            (async () => {
                              try {
                                const cronRewriteSignal = AbortSignal.any([
                                  abortController.signal,
                                  AbortSignal.timeout(30_000),
                                ]);
                                const rewritten = await rewriter.rewrite(
                                  content,
                                  cronRewriteSignal,
                                );
                                if (rewritten) {
                                  debugLogger.info(
                                    `Cron turn ${turnIdx}: rewritten ${rewritten.length} chars`,
                                  );
                                  return { turnIdx, text: rewritten };
                                }
                              } catch (err) {
                                debugLogger.warn(
                                  `Cron turn ${turnIdx}: rewrite failed: ${err instanceof Error ? err.message : String(err)}`,
                                );
                              }
                              return null;
                            })(),
                          );
                        }
                      }

                      // Emit settled rewrites before next cron turn
                      await emitSettledRewrites();

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

                          if ('modelOverride' in toolResponse) {
                            cronModelOverride = toolResponse.modelOverride;
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

          // Emit all remaining rewrites before emitting result
          await emitSettledRewrites();

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
