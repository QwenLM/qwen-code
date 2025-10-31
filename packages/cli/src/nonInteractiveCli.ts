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
import type { Content, Part, PartListUnion } from '@google/genai';
import { StreamJsonWriter } from './streamJson/writer.js';
import type {
  StreamJsonUsage,
  StreamJsonUserEnvelope,
} from './streamJson/types.js';
import type { StreamJsonController } from './streamJson/controller.js';

import { handleSlashCommand } from './nonInteractiveCliCommands.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';
import {
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
} from './utils/errors.js';

export interface RunNonInteractiveOptions {
  abortController?: AbortController;
  streamJson?: {
    writer?: StreamJsonWriter;
    controller?: StreamJsonController;
  };
  userEnvelope?: StreamJsonUserEnvelope;
}

function normalizePartList(parts: PartListUnion | null): Part[] {
  if (!parts) {
    return [];
  }

  if (typeof parts === 'string') {
    return [{ text: parts }];
  }

  if (Array.isArray(parts)) {
    return parts.map((part) =>
      typeof part === 'string' ? { text: part } : (part as Part),
    );
  }

  return [parts as Part];
}

function extractPartsFromEnvelope(
  envelope: StreamJsonUserEnvelope | undefined,
): PartListUnion | null {
  if (!envelope) {
    return null;
  }

  const content = envelope.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: Part[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        continue;
      }
      if (block.type === 'text' && block.text) {
        parts.push({ text: block.text });
      } else {
        parts.push({ text: JSON.stringify(block) });
      }
    }
    return parts.length > 0 ? parts : null;
  }

  return null;
}

function extractUsageFromGeminiClient(
  geminiClient: unknown,
): StreamJsonUsage | undefined {
  if (
    !geminiClient ||
    typeof geminiClient !== 'object' ||
    typeof (geminiClient as { getChat?: unknown }).getChat !== 'function'
  ) {
    return undefined;
  }

  try {
    const chat = (geminiClient as { getChat: () => unknown }).getChat();
    if (
      !chat ||
      typeof chat !== 'object' ||
      typeof (chat as { getDebugResponses?: unknown }).getDebugResponses !==
        'function'
    ) {
      return undefined;
    }

    const responses = (
      chat as {
        getDebugResponses: () => Array<Record<string, unknown>>;
      }
    ).getDebugResponses();
    for (let i = responses.length - 1; i >= 0; i--) {
      const metadata = responses[i]?.['usageMetadata'] as
        | Record<string, unknown>
        | undefined;
      if (metadata) {
        const promptTokens = metadata['promptTokenCount'];
        const completionTokens = metadata['candidatesTokenCount'];
        const totalTokens = metadata['totalTokenCount'];
        const cachedTokens = metadata['cachedContentTokenCount'];

        return {
          input_tokens:
            typeof promptTokens === 'number' ? promptTokens : undefined,
          output_tokens:
            typeof completionTokens === 'number' ? completionTokens : undefined,
          total_tokens:
            typeof totalTokens === 'number' ? totalTokens : undefined,
          cache_read_input_tokens:
            typeof cachedTokens === 'number' ? cachedTokens : undefined,
        };
      }
    }
  } catch (error) {
    console.debug('Failed to extract usage metadata:', error);
  }

  return undefined;
}

function calculateApproximateCost(
  usage: StreamJsonUsage | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }
  return 0;
}

export async function runNonInteractive(
  config: Config,
  settings: LoadedSettings,
  input: string,
  prompt_id: string,
  options: RunNonInteractiveOptions = {},
): Promise<void> {
  return promptIdContext.run(prompt_id, async () => {
    const consolePatcher = new ConsolePatcher({
      stderr: true,
      debugMode: config.getDebugMode(),
    });

    const isStreamJsonOutput = config.getOutputFormat() === 'stream-json';
    const streamJsonContext = options.streamJson;
    const streamJsonWriter = isStreamJsonOutput
      ? (streamJsonContext?.writer ??
        new StreamJsonWriter(config, config.getIncludePartialMessages()))
      : undefined;

    let turnCount = 0;
    let totalApiDurationMs = 0;
    const startTime = Date.now();

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
      const abortController = options.abortController ?? new AbortController();
      streamJsonContext?.controller?.setActiveRunAbortController?.(
        abortController,
      );

      let initialPartList: PartListUnion | null = extractPartsFromEnvelope(
        options.userEnvelope,
      );
      let usedEnvelopeInput = initialPartList !== null;

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
            usedEnvelopeInput = false;
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
          usedEnvelopeInput = false;
        }
      }

      if (!initialPartList) {
        initialPartList = [{ text: input }];
        usedEnvelopeInput = false;
      }

      const initialParts = normalizePartList(initialPartList);
      let currentMessages: Content[] = [{ role: 'user', parts: initialParts }];

      if (streamJsonWriter && !usedEnvelopeInput) {
        streamJsonWriter.emitUserMessageFromParts(initialParts);
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

        const assistantBuilder = streamJsonWriter?.createAssistantBuilder();
        let responseText = '';

        for await (const event of responseStream) {
          if (abortController.signal.aborted) {
            handleCancellationError(config);
          }

          if (event.type === GeminiEventType.Content) {
            if (streamJsonWriter) {
              assistantBuilder?.appendText(event.value);
            } else if (config.getOutputFormat() === OutputFormat.JSON) {
              responseText += event.value;
            } else {
              process.stdout.write(event.value);
            }
          } else if (event.type === GeminiEventType.Thought) {
            if (streamJsonWriter) {
              const subject = event.value.subject?.trim();
              const description = event.value.description?.trim();
              const combined = [subject, description]
                .filter((part) => part && part.length > 0)
                .join(': ');
              if (combined.length > 0) {
                assistantBuilder?.appendThinking(combined);
              }
            }
          } else if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
            if (streamJsonWriter) {
              assistantBuilder?.appendToolUse(event.value);
            }
          }
        }

        assistantBuilder?.finalize();
        totalApiDurationMs += Date.now() - apiStartTime;

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
              if (streamJsonWriter) {
                const message =
                  toolResponse.resultDisplay || toolResponse.error.message;
                streamJsonWriter.emitSystemMessage('tool_error', {
                  tool: requestInfo.name,
                  message,
                });
              }
            }

            if (streamJsonWriter) {
              streamJsonWriter.emitToolResult(requestInfo, toolResponse);
            }

            if (toolResponse.responseParts) {
              toolResponseParts.push(...toolResponse.responseParts);
            }
          }
          currentMessages = [{ role: 'user', parts: toolResponseParts }];
        } else {
          if (streamJsonWriter) {
            const usage = extractUsageFromGeminiClient(geminiClient);
            streamJsonWriter.emitResult({
              isError: false,
              durationMs: Date.now() - startTime,
              apiDurationMs: totalApiDurationMs,
              numTurns: turnCount,
              usage,
              totalCostUsd: calculateApproximateCost(usage),
            });
          } else if (config.getOutputFormat() === OutputFormat.JSON) {
            const formatter = new JsonFormatter();
            const stats = uiTelemetryService.getMetrics();
            process.stdout.write(formatter.format(responseText, stats));
          } else {
            // Preserve the historical newline after a successful non-interactive run.
            process.stdout.write('\n');
          }
          return;
        }
      }
    } catch (error) {
      if (streamJsonWriter) {
        const usage = extractUsageFromGeminiClient(config.getGeminiClient());
        const message = error instanceof Error ? error.message : String(error);
        streamJsonWriter.emitResult({
          isError: true,
          durationMs: Date.now() - startTime,
          apiDurationMs: totalApiDurationMs,
          numTurns: turnCount,
          errorMessage: message,
          usage,
          totalCostUsd: calculateApproximateCost(usage),
        });
      }
      handleError(error, config);
    } finally {
      streamJsonContext?.controller?.setActiveRunAbortController?.(null);
      consolePatcher.cleanup();
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry(config);
      }
    }
  });
}
