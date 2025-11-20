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
  JsonFormatter,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';

import type { Content, Part } from '@google/genai';

import { handleSlashCommand } from './nonInteractiveCliCommands.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';
import {
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
} from './utils/errors.js';

export async function runNonInteractive(
  config: Config,
  settings: LoadedSettings,
  input: string,
  prompt_id: string,
): Promise<void> {
  return promptIdContext.run(prompt_id, async () => {
    const consolePatcher = new ConsolePatcher({
      stderr: true,
      debugMode: config.getDebugMode(),
    });

    try {
      consolePatcher.patch();
      // Handle EPIPE errors when the output is piped to a command that closes early.
      process.stdout.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          // Exit gracefully if the pipe is closed.
          process.exit(0);
        }
      });

      const geminiClient = config.getGeminiClient();

      const abortController = new AbortController();

      let query: Part[] | undefined;

      if (isSlashCommand(input)) {
        const slashCommandResult = await handleSlashCommand(
          input,
          abortController,
          config,
          settings,
        );
        // If a slash command is found and returns a prompt, use it.
        // Otherwise, slashCommandResult fall through to the default prompt
        // handling.
        if (slashCommandResult) {
          query = slashCommandResult as Part[];
        }
      }

      if (!query) {
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
        query = processedQuery as Part[];
      }

      let currentMessages: Content[] = [{ role: 'user', parts: query }];

      // Output message start event in stream-json format if applicable
      if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
        const startEvent = {
          type: 'message_start',
          message: {
            id: prompt_id,
            model: config.getModel() || 'unknown',
          },
        };
        process.stdout.write(JSON.stringify(startEvent) + '\n');
      }

      let turnCount = 0;
      while (true) {
        turnCount++;
        if (
          config.getMaxSessionTurns() >= 0 &&
          turnCount > config.getMaxSessionTurns()
        ) {
          handleMaxTurnsExceededError(config);
        }
        const toolCallRequests: ToolCallRequestInfo[] = [];

        const responseStream = geminiClient.sendMessageStream(
          currentMessages[0]?.parts || [],
          abortController.signal,
          prompt_id,
        );

        let responseText = '';
        for await (const event of responseStream) {
          if (abortController.signal.aborted) {
            if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
              const cancelEvent = {
                type: 'message_stop',
                stop_reason: 'user_cancel',
              };
              process.stdout.write(JSON.stringify(cancelEvent) + '\n');
            }
            handleCancellationError(config);
          }

          switch (event.type) {
            case GeminiEventType.Content:
              if (config.getOutputFormat() === OutputFormat.JSON) {
                responseText += event.value;
              } else if (
                config.getOutputFormat() === OutputFormat.STREAM_JSON
              ) {
                // Output in Claude-compatible stream-json format
                const streamEvent = {
                  type: 'content_block_delta',
                  text: event.value,
                };
                process.stdout.write(JSON.stringify(streamEvent) + '\n');
              } else {
                process.stdout.write(event.value);
              }
              break;

            case GeminiEventType.ToolCallRequest:
              toolCallRequests.push(event.value);
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output tool call in stream-json format
                const toolCallEvent = {
                  type: 'tool_call',
                  name: event.value.name,
                  arguments: event.value.args,
                };
                process.stdout.write(JSON.stringify(toolCallEvent) + '\n');
              }
              break;

            case GeminiEventType.Finished:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output finish event in stream-json format
                const finishEvent = {
                  type: 'message_delta',
                  delta: { stop_reason: event.value?.reason || 'end_turn' },
                  usage: event.value?.usageMetadata || {},
                };
                process.stdout.write(JSON.stringify(finishEvent) + '\n');
              }
              break;

            case GeminiEventType.Error:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output error event in stream-json format
                const errorEvent = {
                  type: 'error',
                  error: event.value,
                };
                process.stdout.write(JSON.stringify(errorEvent) + '\n');
              }
              break;

            case GeminiEventType.Thought:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output thought event in stream-json format
                const thoughtEvent = {
                  type: 'thought',
                  content: event.value,
                };
                process.stdout.write(JSON.stringify(thoughtEvent) + '\n');
              }
              break;

            case GeminiEventType.Citation:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output citation event in stream-json format
                const citationEvent = {
                  type: 'citation',
                  content: event.value,
                };
                process.stdout.write(JSON.stringify(citationEvent) + '\n');
              }
              break;

            case GeminiEventType.UserCancelled:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output cancellation event in stream-json format
                const cancelEvent = {
                  type: 'message_stop',
                  stop_reason: 'user_cancel',
                };
                process.stdout.write(JSON.stringify(cancelEvent) + '\n');
              }
              break;

            case GeminiEventType.LoopDetected:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output loop detected event in stream-json format
                const loopEvent = {
                  type: 'error',
                  error: 'Loop detected in conversation',
                };
                process.stdout.write(JSON.stringify(loopEvent) + '\n');
              }
              break;

            case GeminiEventType.MaxSessionTurns:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output max turns event in stream-json format
                const maxTurnsEvent = {
                  type: 'error',
                  error: 'Maximum session turns exceeded',
                };
                process.stdout.write(JSON.stringify(maxTurnsEvent) + '\n');
              }
              break;

            case GeminiEventType.ChatCompressed:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output compression event in stream-json format
                const compressEvent = {
                  type: 'info',
                  message: 'Chat history compressed',
                  value: event.value,
                };
                process.stdout.write(JSON.stringify(compressEvent) + '\n');
              }
              break;

            case GeminiEventType.SessionTokenLimitExceeded:
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Output token limit event in stream-json format
                const tokenLimitEvent = {
                  type: 'error',
                  error: event.value,
                };
                process.stdout.write(JSON.stringify(tokenLimitEvent) + '\n');
              }
              break;

            // Add other event types as needed
            default:
              // For any other events, we can log them in stream format only if debugging
              if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
                // Handle events that may or may not have a value
                if ('value' in event) {
                  const genericEvent = {
                    type: 'unknown_event',
                    original_type: event.type,
                    value: event.value,
                  };
                  process.stdout.write(JSON.stringify(genericEvent) + '\n');
                } else {
                  const genericEvent = {
                    type: 'unknown_event',
                    original_type: event.type,
                  };
                  process.stdout.write(JSON.stringify(genericEvent) + '\n');
                }
              }
              break;
          }
        }

        if (toolCallRequests.length > 0) {
          const toolResponseParts: Part[] = [];
          for (const requestInfo of toolCallRequests) {
            const toolResponse = await executeToolCall(
              config,
              requestInfo,
              abortController.signal,
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

            if (toolResponse.responseParts) {
              toolResponseParts.push(...toolResponse.responseParts);
            }
          }
          // If in stream-json mode and we're looping for another turn, output a turn delimiter
          if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
            const turnEvent = {
              type: 'turn_complete',
            };
            process.stdout.write(JSON.stringify(turnEvent) + '\n');
          }

          currentMessages = [{ role: 'user', parts: toolResponseParts }];
        } else {
          if (config.getOutputFormat() === OutputFormat.JSON) {
            const formatter = new JsonFormatter();
            const stats = uiTelemetryService.getMetrics();
            process.stdout.write(formatter.format(responseText, stats));
          } else if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
            // Output end of stream event in Claude-compatible format
            const endEvent = {
              type: 'message_stop',
              stop_reason: 'end_turn',
              usage: uiTelemetryService.getMetrics(),
            };
            process.stdout.write(JSON.stringify(endEvent) + '\n');
          } else {
            process.stdout.write('\n'); // Ensure a final newline
          }
          return;
        }
      }
    } catch (error) {
      if (config.getOutputFormat() === OutputFormat.STREAM_JSON) {
        const errorEvent = {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
        process.stdout.write(JSON.stringify(errorEvent) + '\n');
      }
      handleError(error, config);
    } finally {
      consolePatcher.cleanup();
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry(config);
      }
    }
  });
}
