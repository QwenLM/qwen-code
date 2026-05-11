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
} from './utils/errors.js';
import {
  normalizePartList,
  extractPartsFromUserMessage,
  buildSystemMessage,
  createToolProgressHandler,
  createAgentToolProgressHandler,
  computeUsageFromMetrics,
} from './utils/nonInteractiveHelpers.js';

const debugLogger = createDebugLogger('NON_INTERACTIVE_CLI');

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

    try {
      process.stdout.on('error', stdoutErrorHandler);

      process.on('SIGINT', shutdownHandler);
      process.on('SIGTERM', shutdownHandler);

      // Emit systemMessage first (always the first message in JSON mode)
      const systemMessage = await buildSystemMessage(
        config,
        sessionId,
        permissionMode,
        settings,
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
      let modelOverride: string | undefined;
      // Captures the first ~200 chars of model-emitted plain text across
      // turns. Used only to enrich the --json-schema "produced plain
      // text" error: the user/operator gets a hint of what the model
      // actually said instead of a static, context-free message.
      let plainTextPreview = '';
      const PLAIN_TEXT_PREVIEW_LIMIT = 200;
      while (true) {
        turnCount++;
        if (
          config.getMaxSessionTurns() >= 0 &&
          turnCount > config.getMaxSessionTurns()
        ) {
          await handleMaxTurnsExceededError(config);
        }

        const toolCallRequests: ToolCallRequestInfo[] = [];
        const apiStartTime = Date.now();
        const responseStream = geminiClient.sendMessageStream(
          currentMessages[0]?.parts || [],
          abortController.signal,
          prompt_id,
          {
            type: isFirstTurn
              ? (options.sendMessageType ?? SendMessageType.UserQuery)
              : SendMessageType.ToolResult,
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
            await handleCancellationError(config);
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
          const toolResponseParts: Part[] = [];
          // When --json-schema is active, the first successful call to the
          // synthetic structured_output tool terminates the session with the
          // submitted args as the structured result. A separate boolean
          // tracks whether a submission happened, since `args` itself may
          // legitimately be undefined or any falsy value (an empty schema
          // `{}` accepts any payload, including no fields at all).
          let structuredSubmission: unknown = undefined;
          let hasStructuredSubmission = false;

          // Pre-scan: when --json-schema is active and the model emitted
          // structured_output alongside other tools in the same turn,
          // execute structured_output FIRST so its terminal-flag wins
          // before sibling tools' side effects (write_file, shell, …)
          // get a chance to persist. If structured_output succeeds the
          // loop breaks immediately and siblings are skipped — no
          // tool_result is emitted for them; the session terminates via
          // the emitResult call below so the missing function_response
          // entries cause no API protocol issue (there is no next turn).
          // If structured_output fails (validation), `hasStructuredSubmission`
          // stays false and the siblings still run via the normal loop
          // body — same behavior as a turn that didn't issue
          // structured_output at all.
          //
          // Without this, [write_file, structured_output] runs write_file
          // first (irreversible), THEN structured_output sets the flag,
          // and the user gets back a "successful" structured result with
          // unrelated side-effects already on disk.
          let orderedToolCallRequests = toolCallRequests;
          if (config.getJsonSchema()) {
            const structIdx = orderedToolCallRequests.findIndex(
              (r) => r.name === ToolNames.STRUCTURED_OUTPUT,
            );
            if (structIdx > 0) {
              orderedToolCallRequests = [
                orderedToolCallRequests[structIdx],
                ...orderedToolCallRequests.slice(0, structIdx),
                ...orderedToolCallRequests.slice(structIdx + 1),
              ];
            }
          }

          for (const requestInfo of orderedToolCallRequests) {
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
            config
              .getGeminiClient()
              .recordCompletedToolCall(
                finalRequestInfo.name,
                finalRequestInfo.args as Record<string, unknown>,
              );

            if (
              finalRequestInfo.name === ToolNames.STRUCTURED_OUTPUT &&
              !toolResponse.error &&
              !hasStructuredSubmission
            ) {
              structuredSubmission = finalRequestInfo.args;
              hasStructuredSubmission = true;
            }

            if (toolResponse.responseParts) {
              toolResponseParts.push(...toolResponse.responseParts);
            }

            // Capture model override from skill tool results.
            // Use `in` so that undefined (from inherit/no-model skills) clears a prior override,
            // while non-skill tools (field absent) leave the current override intact.
            if ('modelOverride' in toolResponse) {
              modelOverride = toolResponse.modelOverride;
            }

            // Single-shot contract: structured_output is terminal.
            // The pre-scan above hoists it to the front of the batch,
            // so once it succeeds the remaining (now reordered)
            // entries are guaranteed to be siblings the model
            // intended for THIS turn — break and let the terminal
            // emitResult fire below. Unpaired tool_use entries in
            // the model's record are harmless because no next API
            // call happens (the session is over).
            if (hasStructuredSubmission) {
              break;
            }
          }
          if (hasStructuredSubmission) {
            // Abort any in-flight background agents so they don't race the
            // terminal emitResult; structured-output mode is a single-shot
            // contract and the caller expects a deterministic shutdown.
            registry.abortAll();
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
            return;
          }
          currentMessages = [{ role: 'user', parts: toolResponseParts }];
        } else {
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
                  // See the matching note in the first stream loop above —
                  // we mark the throw so handleError doesn't reformat or
                  // reprint downstream.
                  throw new AlreadyReportedError(errorText);
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
                  config
                    .getGeminiClient()
                    .recordCompletedToolCall(
                      requestInfo.name,
                      requestInfo.args as Record<string, unknown>,
                    );

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
              flushQueuedNotificationsToSdk(localQueue);
              finalizeOneShotMonitors();
              await handleCancellationError(config);
            }
            // Once we enter the final holdback loop, monitor events should no
            // longer extend one-shot runtime. Already-queued events still drain
            // through the model, but later monitor output is SDK-only.
            captureMonitorTurnsInLocalQueue = false;
            await drainLocalQueue();
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

          // --json-schema contract: the model MUST terminate via the
          // structured_output tool. Reaching this branch means it emitted
          // plain text instead — surface as an error rather than silently
          // returning whatever free-form summary the adapter collected.
          // Setting exitCode + returning (rather than throwing) avoids the
          // outer catch re-emitting the result a second time.
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
            // Adapter handles user-visible feedback per output format:
            //   - TEXT: writes errorMessage to stderr (JsonOutputAdapter
            //     emitResult, line ~70).
            //   - JSON / STREAM_JSON: emits the structured result with
            //     is_error=true.
            // No extra stderr write here — duplicating in TEXT mode
            // produced two copies of the same line in headless runs.
            process.exitCode = 1;
            return;
          }

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

      flushQueuedNotificationsToSdk(localQueue);
      finalizeOneShotMonitors();

      // For JSON and STREAM_JSON modes, compute usage from metrics
      const message = error instanceof Error ? error.message : String(error);
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
      await handleError(error, config);
    } finally {
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
  });
}
