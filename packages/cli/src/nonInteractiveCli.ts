/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ToolCallRequestInfo } from '@qwen-code/qwen-code-core';
import {
  executeToolCall,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  parseAndFormatApiError,
  FatalInputError,
  FatalTurnLimitedError,
  ToolConfirmationOutcome,
  convertToFunctionResponse,
} from '@qwen-code/qwen-code-core';
import type { Content, Part, PartListUnion } from '@google/genai';

import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';
import type { ExecuteToolCallOptions } from '@qwen-code/qwen-code-core';
import type { StreamJsonController } from './streamJson/controller.js';
import { StreamJsonWriter } from './streamJson/writer.js';
import type {
  StreamJsonContentBlock,
  StreamJsonUsage,
  StreamJsonUserEnvelope,
} from './streamJson/types.js';
import type { StreamJsonControlContext } from './streamJson/session.js';

export interface RunNonInteractiveOptions {
  abortController?: AbortController;
  streamJson?: {
    writer: StreamJsonWriter;
    controller: StreamJsonController;
    toolCallRegistry?: Map<string, ToolCallRequestInfo>;
    controlContext?: StreamJsonControlContext;
  };
  userEnvelope?: StreamJsonUserEnvelope;
}

interface AwaitingApprovalToolCall {
  request: ToolCallRequestInfo;
  confirmationDetails: {
    type: string;
    onConfirm: (
      outcome: ToolConfirmationOutcome,
      payload?: unknown,
    ) => Promise<void>;
    [key: string]: unknown;
  };
}

function buildPermissionSuggestions(
  confirmationDetails: unknown,
): unknown {
  if (
    !confirmationDetails ||
    typeof confirmationDetails !== 'object' ||
    !('type' in confirmationDetails)
  ) {
    return null;
  }

  const details = confirmationDetails as Record<string, unknown>;
  const type = String(details['type'] ?? '');
  const title = typeof details['title'] === 'string' ? details['title'] : undefined;

  switch (type) {
    case 'exec':
      return [
        {
          type: 'command',
          title,
          command: details['command'],
          root_command: details['rootCommand'],
        },
      ];
    case 'edit':
      return [
        {
          type: 'diff',
          title,
          file_name: details['fileName'],
          file_path: details['filePath'],
          diff: details['fileDiff'],
          original_content: details['originalContent'],
          new_content: details['newContent'],
        },
      ];
    case 'plan':
      return [
        {
          type: 'plan',
          title,
          plan: details['plan'],
        },
      ];
    case 'mcp':
      return [
        {
          type: 'mcp',
          title,
          server_name: details['serverName'],
          tool_name: details['toolName'],
          tool_display_name: details['toolDisplayName'],
        },
      ];
    case 'info':
      return [
        {
          type: 'info',
          title,
          prompt: details['prompt'],
          urls: details['urls'],
        },
      ];
    default:
      return [
        {
          type,
          title,
        },
      ];
  }
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

function extractStructuredPartsFromEnvelope(
  envelope: StreamJsonUserEnvelope,
  registry?: Map<string, ToolCallRequestInfo>,
): Part[] {
  const content = envelope.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: Part[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      continue;
    }

    if (block.type === 'tool_result') {
      const toolUseId =
        typeof block.tool_use_id === 'string' && block.tool_use_id.trim()
          ? block.tool_use_id
          : envelope.parent_tool_use_id;

      if (toolUseId && registry?.has(toolUseId)) {
        const requestInfo = registry.get(toolUseId)!;
        const responseParts = convertToFunctionResponse(
          requestInfo.name,
          requestInfo.callId,
          toolResultContentToPartList(block.content),
        );
        registry.delete(toolUseId);
        if (Array.isArray(responseParts)) {
          parts.push(...responseParts);
        } else if (responseParts) {
          parts.push(responseParts as Part);
        }
        continue;
      }

      const fallbackText = buildToolResultFallbackText(block);
      if (fallbackText) {
        parts.push({ text: fallbackText });
      }
      continue;
    }

    if (block.type === 'text') {
      if (block.text) {
        parts.push({ text: block.text });
      }
      continue;
    }

    if (block.type === 'thinking') {
      if (block.thinking) {
        parts.push({ text: block.thinking });
      }
      continue;
    }

    parts.push({ text: JSON.stringify(block) });
  }

  return parts;
}

function toolResultContentToPartList(
  content?: StreamJsonContentBlock[] | string,
): PartListUnion {
  if (!content) {
    return [{ text: '' }];
  }

  if (typeof content === 'string') {
    return content;
  }

  const parts: Part[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || !('type' in item)) {
      continue;
    }
    if (item.type === 'text') {
      parts.push({ text: item.text ?? '' });
    } else {
      parts.push({ text: JSON.stringify(item) });
    }
  }

  return parts.length > 0 ? parts : [{ text: '' }];
}

function buildToolResultFallbackText(
  block: Extract<StreamJsonContentBlock, { type: 'tool_result' }>,
): string | undefined {
  if (typeof block.content === 'string') {
    return block.content;
  }

  if (Array.isArray(block.content)) {
    const fragments: string[] = [];
    for (const item of block.content) {
      if (!item || typeof item !== 'object' || !('type' in item)) {
        continue;
      }
      if (item.type === 'text') {
        if (item.text) {
          fragments.push(item.text);
        }
      } else {
        fragments.push(JSON.stringify(item));
      }
    }
    if (fragments.length > 0) {
      return fragments.join('');
    }
  }

  if (block.is_error) {
    return 'Tool execution reported an error without content.';
  }

  return undefined;
}

async function applyTemporaryEnvelopeOptions(
  config: Config,
  envelope?: StreamJsonUserEnvelope,
): Promise<() => Promise<void>> {
  const restoreStack: Array<() => Promise<void>> = [];
  const rawOptions = envelope?.options;

  if (rawOptions && typeof rawOptions === 'object') {
    const options = rawOptions as Record<string, unknown>;
    const temporaryModelRaw = options['temporary_model'];
    if (typeof temporaryModelRaw === 'string') {
      const temporaryModel = temporaryModelRaw.trim();
      if (temporaryModel.length > 0) {
        const originalModel = config.getModel();
        if (temporaryModel !== originalModel) {
          await config.setModel(temporaryModel, {
            reason: 'stream-json-options',
            context: 'temporary_model',
          });
          restoreStack.push(async () => {
            try {
              await config.setModel(originalModel, {
                reason: 'stream-json-options',
                context: 'temporary_model_restore',
              });
            } catch (error) {
              console.debug(
                'Failed to restore model after temporary stream-json option:',
                error,
              );
            }
          });
        }
      }
    }
  }

  return async () => {
    for (const restore of restoreStack.reverse()) {
      await restore();
    }
  };
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

    const responses = (chat as {
      getDebugResponses: () => Array<Record<string, unknown>>;
    }).getDebugResponses();
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
            typeof completionTokens === 'number'
              ? completionTokens
              : undefined,
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
  // Pricing details are not currently exposed; report zero until available.
  return 0;
}

const CONTROL_REQUEST_TIMEOUT_MS = 60_000;
const HOOK_CALLBACK_TIMEOUT_MS = CONTROL_REQUEST_TIMEOUT_MS;

type HookCallbackMessage = {
  event: string;
  callbackId: string;
  message: string;
};

type HookCallbackAggregateResult = {
  shouldSkip: boolean;
  shouldInterrupt: boolean;
  suppressOutput: boolean;
  messages: HookCallbackMessage[];
};

export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
  options: RunNonInteractiveOptions = {},
): Promise<void> {
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: config.getDebugMode(),
  });

  const isStreamJsonOutput = config.getOutputFormat() === 'stream-json';
  const streamJsonWriter = isStreamJsonOutput
    ? options.streamJson?.writer ??
      new StreamJsonWriter(config, config.getIncludePartialMessages())
    : undefined;
  const streamJsonContext = options.streamJson;
  const toolCallRegistry = streamJsonContext?.toolCallRegistry;
  const controlContext = streamJsonContext?.controlContext;
  const pendingPermissionRequests = new Set<string>();
  let totalApiDurationMs = 0;
  const startTime = Date.now();
  let turnCount = 0;
  let cleanupTemporaryOptions: (() => Promise<void>) | undefined;

  const emitHookMessages = (messages: HookCallbackMessage[]): void => {
    if (!streamJsonWriter || messages.length === 0) {
      return;
    }
    for (const { event, callbackId, message } of messages) {
      streamJsonWriter.emitSystemMessage('hook_callback', {
        event,
        callback_id: callbackId,
        message,
      });
    }
  };

  const buildHookInput = (
    event: string,
    toolCall: ToolCallRequestInfo,
    responseSummary?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = {
      event,
      tool: {
        name: toolCall.name,
        input: toolCall.args,
        call_id: toolCall.callId,
      },
    };
    if (responseSummary) {
      input['response'] = responseSummary;
    }
    return input;
  };

  const summarizeToolResponse = (
    toolResponse: Record<string, unknown>,
  ): Record<string, unknown> => {
    const summary: Record<string, unknown> = {
      is_error: Boolean(toolResponse['error']),
    };
    if (toolResponse['resultDisplay'] !== undefined) {
      summary['result_display'] = toolResponse['resultDisplay'];
    }
    if (Array.isArray(toolResponse['responseParts'])) {
      summary['response_parts_count'] = (toolResponse['responseParts'] as unknown[]).length;
    }
    const errorInfo = toolResponse['error'];
    if (errorInfo && typeof errorInfo === 'object') {
      const message = (errorInfo as { message?: unknown }).message;
      const type = (errorInfo as { type?: unknown }).type;
      summary['error'] = {
        message: typeof message === 'string' ? message : undefined,
        type: typeof type === 'string' ? type : undefined,
      };
    }
    return summary;
  };

  const dispatchHookCallbacks = async (
    event: string,
    toolCall: ToolCallRequestInfo,
    responseSummary?: Record<string, unknown>,
  ): Promise<HookCallbackAggregateResult> => {
    const initial: HookCallbackAggregateResult = {
      shouldSkip: false,
      shouldInterrupt: false,
      suppressOutput: false,
      messages: [],
    };

    if (
      !isStreamJsonOutput ||
      !streamJsonContext?.controller ||
      !controlContext ||
      controlContext.hookCallbacks.size === 0 ||
      !controlContext.registeredHookEvents.has(event)
    ) {
      return initial;
    }

    const callbacks: string[] = [];
    for (const [callbackId, registration] of controlContext.hookCallbacks) {
      if (registration.event === event) {
        callbacks.push(callbackId);
      }
    }

    if (callbacks.length === 0) {
      return initial;
    }

    const aggregate: HookCallbackAggregateResult = {
      shouldSkip: false,
      shouldInterrupt: false,
      suppressOutput: false,
      messages: [],
    };

    for (const callbackId of callbacks) {
      try {
        const responseEnvelope = await streamJsonContext.controller.sendControlRequest(
          'hook_callback',
          {
            callback_id: callbackId,
            tool_use_id: toolCall.callId,
            input: buildHookInput(event, toolCall, responseSummary),
          },
          { timeoutMs: HOOK_CALLBACK_TIMEOUT_MS },
        );

        if (!responseEnvelope.success) {
          const errorDetail = responseEnvelope.error;
          const errorMessage =
            typeof errorDetail === 'string'
              ? errorDetail
              : errorDetail && typeof errorDetail === 'object'
                ? String((errorDetail as { message?: unknown }).message ?? '')
                : 'Hook callback failed';
          streamJsonWriter?.emitSystemMessage('hook_callback', {
            event,
            callback_id: callbackId,
            error: errorMessage,
          });
          continue;
        }

        const responsePayload =
          (responseEnvelope.response ?? {}) as Record<string, unknown>;

        const decisionRaw = responsePayload['decision'];
        const decision =
          typeof decisionRaw === 'string' ? decisionRaw.toLowerCase() : undefined;
        const continueFlag = responsePayload['continue'];
        if (
          decision &&
          ['cancel', 'stop', 'interrupt', 'deny', 'abort'].includes(decision)
        ) {
          aggregate.shouldSkip = true;
          if (decision === 'interrupt') {
            aggregate.shouldInterrupt = true;
          }
        }
        if (continueFlag === false) {
          aggregate.shouldSkip = true;
        }
        if (responsePayload['interrupt'] === true) {
          aggregate.shouldInterrupt = true;
        }
        if (responsePayload['suppressOutput'] === true) {
          aggregate.suppressOutput = true;
        }

        const systemMessage = responsePayload['systemMessage'];
        if (typeof systemMessage === 'string' && systemMessage.trim().length > 0) {
          aggregate.messages.push({
            event,
            callbackId,
            message: systemMessage,
          });
        } else {
          const reason = responsePayload['reason'];
          if (typeof reason === 'string' && reason.trim().length > 0) {
            aggregate.messages.push({
              event,
              callbackId,
              message: reason,
            });
          }
        }
      } catch (error) {
        streamJsonWriter?.emitSystemMessage('hook_callback', {
          event,
          callback_id: callbackId,
          error:
            error instanceof Error
              ? error.message
              : 'Hook callback request failed',
        });
      }
    }

    return aggregate;
  };

  const handleToolPermissionRequest = async (
    toolCall: AwaitingApprovalToolCall,
  ): Promise<void> => {
    const controller = streamJsonContext?.controller;
    if (!controller || !streamJsonWriter) {
      await toolCall.confirmationDetails.onConfirm(
        ToolConfirmationOutcome.ProceedOnce,
      );
      pendingPermissionRequests.delete(toolCall.request.callId);
      return;
    }

    try {
      const responseEnvelope = await controller.sendControlRequest(
        'can_use_tool',
        {
          tool_name: toolCall.request.name,
          tool_use_id: toolCall.request.callId,
          input: toolCall.request.args,
          permission_suggestions: buildPermissionSuggestions(
            toolCall.confirmationDetails,
          ),
        },
        { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS },
      );

      if (!responseEnvelope.success) {
        const errorDetail = responseEnvelope.error;
        const errorMessage =
          typeof errorDetail === 'string'
            ? errorDetail
            : errorDetail && typeof errorDetail === 'object' && 'message' in errorDetail
              ? String((errorDetail as { message?: unknown }).message ?? '')
              : 'Tool permission request was rejected by control_response.';
        if (streamJsonWriter) {
          streamJsonWriter.emitSystemMessage('tool_permission', {
            tool: toolCall.request.name,
            behavior: 'error',
            message: errorMessage,
          });
        }
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
        );
        return;
      }

      const responsePayload =
        (responseEnvelope.response ?? {}) as Record<string, unknown>;
      const behavior = String(responsePayload['behavior'] ?? '').toLowerCase();
      const responseMessage =
        typeof responsePayload['message'] === 'string'
          ? responsePayload['message']
          : undefined;

      if (behavior === 'allow') {
        const updatedInput = responsePayload['updatedInput'];
        if (updatedInput && typeof updatedInput === 'object') {
          toolCall.request.args = updatedInput as Record<string, unknown>;
        }
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedOnce,
        );
      } else {
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
        );
      }

      if (responseMessage && streamJsonWriter) {
        streamJsonWriter.emitSystemMessage('tool_permission', {
          tool: toolCall.request.name,
          behavior,
          message: responseMessage,
        });
      }

      if (responsePayload['interrupt']) {
        controller.interruptActiveRun();
      }
    } catch (error) {
      if (streamJsonWriter) {
        streamJsonWriter.emitSystemMessage('tool_permission', {
          tool: toolCall.request.name,
          behavior: 'error',
          message:
            error instanceof Error ? error.message : 'Tool permission request failed',
        });
      }
      await toolCall.confirmationDetails.onConfirm(
        ToolConfirmationOutcome.Cancel,
      );
    } finally {
      pendingPermissionRequests.delete(toolCall.request.callId);
    }
  };

  const handleToolSchedulerUpdate = (toolCalls: unknown[]): void => {
    for (const call of toolCalls) {
      if (
        call &&
        typeof call === 'object' &&
        (call as { status?: string }).status === 'awaiting_approval'
      ) {
        const awaiting = call as AwaitingApprovalToolCall;
        if (
          awaiting.confirmationDetails?.onConfirm &&
          !pendingPermissionRequests.has(awaiting.request.callId)
        ) {
          pendingPermissionRequests.add(awaiting.request.callId);
          void handleToolPermissionRequest(awaiting);
        }
      }
    }
  };

  const geminiClient = config.getGeminiClient();

  try {
    consolePatcher.patch();
    // Handle EPIPE errors when the output is piped to a command that closes early.
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        // Exit gracefully if the pipe is closed.
        process.exit(0);
      }
    });

    const abortController =
      options.abortController ?? new AbortController();
    cleanupTemporaryOptions = await applyTemporaryEnvelopeOptions(
      config,
      options.userEnvelope,
    );

    const userEnvelope = options.userEnvelope;
    let shouldEmitUserEcho = !userEnvelope;
    let initialPartList: PartListUnion | null = null;

    if (userEnvelope) {
      const structuredParts = extractStructuredPartsFromEnvelope(
        userEnvelope,
        toolCallRegistry,
      );
      if (structuredParts.length > 0) {
        initialPartList = structuredParts;
        shouldEmitUserEcho = false;
      }
    }

    if (!initialPartList) {
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

      initialPartList = processedQuery;
    }

    const initialParts = normalizePartList(initialPartList);
    let currentMessages: Content[] = [{ role: 'user', parts: initialParts }];

    if (isStreamJsonOutput && shouldEmitUserEcho) {
      streamJsonWriter?.emitUserMessageFromParts(initialParts);
    }

    while (true) {
      turnCount++;
      if (
        config.getMaxSessionTurns() >= 0 &&
        turnCount > config.getMaxSessionTurns()
      ) {
        throw new FatalTurnLimitedError(
          'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );
      }
      const toolCallRequests: ToolCallRequestInfo[] = [];

      const apiStartTime = Date.now();
      const responseStream = geminiClient.sendMessageStream(
        currentMessages[0]?.parts || [],
        abortController.signal,
        prompt_id,
      );

      const assistantBuilder = streamJsonWriter?.createAssistantBuilder();

      for await (const event of responseStream) {
        if (abortController.signal.aborted) {
          console.error('Operation cancelled.');
          return;
        }

        if (event.type === GeminiEventType.Content) {
          if (isStreamJsonOutput) {
            assistantBuilder?.appendText(event.value);
          } else {
            process.stdout.write(event.value);
          }
        } else if (event.type === GeminiEventType.Thought) {
          if (isStreamJsonOutput && event.value) {
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
          if (toolCallRegistry) {
            toolCallRegistry.set(event.value.callId, event.value);
          }
          if (isStreamJsonOutput) {
            assistantBuilder?.appendToolUse(event.value);
          }
        }
      }

      assistantBuilder?.finalize();
      totalApiDurationMs += Date.now() - apiStartTime;

      if (toolCallRequests.length > 0) {
        const toolResponseParts: Part[] = [];
        pendingPermissionRequests.clear();
        const executeOptions: ExecuteToolCallOptions | undefined =
          streamJsonContext
            ? {
                onToolCallsUpdate: handleToolSchedulerUpdate,
              }
            : undefined;
        for (const requestInfo of toolCallRequests) {
          if (isStreamJsonOutput && streamJsonContext?.controller && controlContext) {
            const hookResult = await dispatchHookCallbacks('pre_tool', requestInfo);
            emitHookMessages(hookResult.messages);
            if (hookResult.shouldInterrupt) {
              streamJsonContext.controller.interruptActiveRun();
              abortController.abort();
              return;
            }
            if (hookResult.shouldSkip) {
              toolCallRegistry?.delete(requestInfo.callId);
              continue;
            }
          }

          const toolResponse = await executeToolCall(
            config,
            requestInfo,
            abortController.signal,
            executeOptions,
          );

          if (toolResponse.error) {
            const message =
              toolResponse.resultDisplay || toolResponse.error.message;
            console.error(
              `Error executing tool ${requestInfo.name}: ${message}`,
            );
            if (isStreamJsonOutput) {
              streamJsonWriter?.emitSystemMessage('tool_error', {
                tool: requestInfo.name,
                message,
              });
            }
          }

          let suppressOutput = false;
          if (isStreamJsonOutput && streamJsonContext?.controller && controlContext) {
            const responseSummary = summarizeToolResponse(
              toolResponse as unknown as Record<string, unknown>,
            );
            const postHook = await dispatchHookCallbacks(
              'post_tool',
              requestInfo,
              responseSummary,
            );
            emitHookMessages(postHook.messages);
            if (postHook.shouldInterrupt) {
              streamJsonContext.controller.interruptActiveRun();
              abortController.abort();
              return;
            }
            suppressOutput = postHook.suppressOutput;
          }

          if (isStreamJsonOutput && !suppressOutput) {
            streamJsonWriter?.emitToolResult(requestInfo, toolResponse);
          }

          if (toolResponse.responseParts) {
            toolResponseParts.push(...toolResponse.responseParts);
          }

          toolCallRegistry?.delete(requestInfo.callId);
        }
        currentMessages = [{ role: 'user', parts: toolResponseParts }];
      } else {
        if (isStreamJsonOutput) {
          const usage = extractUsageFromGeminiClient(geminiClient);
          streamJsonWriter?.emitResult({
            isError: false,
            durationMs: Date.now() - startTime,
            apiDurationMs: totalApiDurationMs,
            numTurns: turnCount,
            usage,
            totalCostUsd: calculateApproximateCost(usage),
          });
        } else {
          process.stdout.write('\n'); // Ensure a final newline
        }
        return;
      }
    }
  } catch (error) {
    const formattedError = parseAndFormatApiError(
      error,
      config.getContentGeneratorConfig()?.authType,
    );
    console.error(formattedError);
    if (isStreamJsonOutput) {
      const usage = extractUsageFromGeminiClient(geminiClient);
      streamJsonWriter?.emitResult({
        isError: true,
        durationMs: Date.now() - startTime,
        apiDurationMs: totalApiDurationMs,
        numTurns: turnCount,
        errorMessage: formattedError,
        usage,
        totalCostUsd: calculateApproximateCost(usage),
      });
    }
    throw error;
  } finally {
    if (cleanupTemporaryOptions) {
      await cleanupTemporaryOptions();
    }
    consolePatcher.cleanup();
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry(config);
    }
  }
}
