/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  FunctionCall,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import type {
  Config,
  GeminiChat,
  ToolCallConfirmationDetails,
  ToolResult,
  ChatRecord,
  AgentEventEmitter,
  StopHookOutput,
  HookExecutionRequest,
  HookExecutionResponse,
  MessageBus,
  StreamEvent,
  ChatCompressionInfo,
} from '@qwen-code/qwen-code-core';
import {
  AuthType,
  ApprovalMode,
  CompressionStatus,
  convertToFunctionResponse,
  createDebugLogger,
  DiscoveredMCPTool,
  StreamEventType,
  ToolConfirmationOutcome,
  logToolCall,
  logUserPrompt,
  getErrorStatus,
  UserPromptEvent,
  readManyFiles,
  Storage,
  ToolNames,
  fireNotificationHook,
  firePermissionRequestHook,
  firePreToolUseHook,
  firePostToolUseHook,
  firePostToolUseFailureHook,
  injectPermissionRulesIfMissing,
  NotificationType,
  persistPermissionOutcome,
  createHookOutput,
  generateToolUseId,
  MessageBusType,
  getPlanModeSystemReminder,
  getSubagentSystemReminder,
  getArenaSystemReminder,
  STARTUP_CONTEXT_MODEL_ACK,
  evaluatePermissionFlow,
  needsConfirmation,
  isPlanModeBlocked,
} from '@qwen-code/qwen-code-core';
import { getCommandSubcommandNames } from '../../services/commandMetadata.js';
import { getEffectiveSupportedModes } from '../../services/commandUtils.js';

import { RequestError } from '@agentclientprotocol/sdk';
import type {
  AvailableCommand,
  ContentBlock,
  EmbeddedResourceResource,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  AgentSideConnection,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import { z } from 'zod';
import { normalizePartList } from '../../utils/nonInteractiveHelpers.js';
import {
  handleSlashCommand,
  getAvailableCommands,
  type NonInteractiveSlashCommandResult,
} from '../../nonInteractiveCliCommands.js';
import { isSlashCommand } from '../../ui/utils/commandUtils.js';
import { CommandKind } from '../../ui/commands/types.js';
import { parseAcpModelOption } from '../../utils/acpModelUtils.js';
import { classifyApiError } from '../../ui/hooks/useGeminiStream.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';

// Import modular session components
import type {
  ApprovalModeValue,
  SessionContext,
  ToolCallStartParams,
} from './types.js';
import { HistoryReplayer } from './HistoryReplayer.js';
import { ToolCallEmitter } from './emitters/ToolCallEmitter.js';
import { PlanEmitter } from './emitters/PlanEmitter.js';
import { MessageEmitter } from './emitters/MessageEmitter.js';
import { SubAgentTracker } from './SubAgentTracker.js';
import {
  buildPermissionRequestContent,
  toPermissionOptions,
} from './permissionUtils.js';
import {
  MessageRewriteMiddleware,
  loadRewriteConfig,
} from './rewrite/index.js';

const debugLogger = createDebugLogger('SESSION');

type AutoCompressionSendResult =
  | { responseStream: AsyncGenerator<StreamEvent>; stopReason?: never }
  | { responseStream: null; stopReason: PromptResponse['stopReason'] };

/**
 * Session represents an active conversation session with the AI model.
 * It uses modular components for consistent event emission:
 * - HistoryReplayer for replaying past conversations
 * - ToolCallEmitter for tool-related session updates
 * - PlanEmitter for todo/plan updates
 * - SubAgentTracker for tracking sub-agent tool calls
 */
export class Session implements SessionContext {
  private pendingPrompt: AbortController | null = null;
  /**
   * Tracks the completion of the current prompt so that the next prompt
   * can await it.  This prevents a new prompt from reading chat history
   * before the previous prompt's tool results have been added —
   * a race condition that causes malformed history on Windows where
   * process termination is slow.
   */
  private pendingPromptCompletion: Promise<void> | null = null;
  private turn: number = 0;
  private readonly runtimeBaseDir: string;

  // Cron scheduling state
  private cronQueue: string[] = [];
  private cronProcessing = false;
  private cronAbortController: AbortController | null = null;
  private cronCompletion: Promise<void> | null = null;
  private cronDisabledByTokenLimit = false;
  private lastPromptTokenCount = 0;
  private lastPromptTokenCountChat: GeminiChat | null = null;

  // Modular components
  private readonly historyReplayer: HistoryReplayer;
  private readonly toolCallEmitter: ToolCallEmitter;
  private readonly planEmitter: PlanEmitter;
  private readonly messageEmitter: MessageEmitter;

  // Message rewrite middleware (optional, installed after history replay)
  messageRewriter?: MessageRewriteMiddleware;

  // Implement SessionContext interface
  readonly sessionId: string;

  constructor(
    id: string,
    readonly config: Config,
    private readonly client: AgentSideConnection,
    private readonly settings: LoadedSettings,
  ) {
    this.sessionId = id;
    this.runtimeBaseDir = Storage.getRuntimeBaseDir();

    // Initialize modular components with this session as context
    this.toolCallEmitter = new ToolCallEmitter(this);
    this.planEmitter = new PlanEmitter(this);
    this.historyReplayer = new HistoryReplayer(this);
    this.messageEmitter = new MessageEmitter(this);
  }

  getId(): string {
    return this.sessionId;
  }

  getConfig(): Config {
    return this.config;
  }

  /**
   * Install the message rewrite middleware if configured.
   * Must be called AFTER history replay to avoid rewriting historical messages.
   */
  installRewriter(): void {
    const rewriteConfig = loadRewriteConfig(this.settings);
    if (rewriteConfig?.enabled) {
      debugLogger.info('Message rewrite middleware enabled');
      this.messageRewriter = new MessageRewriteMiddleware(
        this.config,
        rewriteConfig,
        (update) => this.sendUpdate(update),
      );
    }
  }

  /**
   * Replays conversation history to the client using modular components.
   * Delegates to HistoryReplayer for consistent event emission.
   */
  async replayHistory(records: ChatRecord[]): Promise<void> {
    await this.historyReplayer.replay(records);
  }

  rewindToTurn(targetTurnIndex: number): {
    targetTurnIndex: number;
    apiTruncateIndex: number;
  } {
    if (!Number.isInteger(targetTurnIndex) || targetTurnIndex < 0) {
      throw RequestError.invalidParams(
        undefined,
        'targetTurnIndex must be a non-negative integer',
      );
    }

    if (this.pendingPrompt || this.cronProcessing || this.cronAbortController) {
      throw RequestError.invalidParams(
        undefined,
        'Cannot rewind while a prompt is running',
      );
    }

    const chat = this.config.getGeminiClient()!.getChat();
    const apiHistory = chat.getHistory();
    const apiTruncateIndex = this.#computeApiTruncationIndexForUserTurn(
      apiHistory,
      targetTurnIndex,
    );

    if (apiTruncateIndex < 0) {
      throw RequestError.invalidParams(
        undefined,
        'Cannot rewind to the requested turn. It may have been compressed or does not exist.',
      );
    }

    chat.truncateHistory(apiTruncateIndex);
    chat.stripThoughtsFromHistory();

    this.config.getChatRecordingService()?.rewindRecording(targetTurnIndex, {
      truncatedCount: Math.max(0, apiHistory.length - apiTruncateIndex),
    });

    return { targetTurnIndex, apiTruncateIndex };
  }

  captureHistorySnapshot(): Content[] {
    return this.config.getGeminiClient()!.getChat().getHistory();
  }

  restoreHistory(history: Content[]): void {
    if (this.pendingPrompt || this.cronProcessing || this.cronAbortController) {
      throw RequestError.invalidParams(
        undefined,
        'Cannot restore history while a prompt is running',
      );
    }

    this.config
      .getGeminiClient()!
      .getChat()
      .setHistory(structuredClone(history));
  }

  #computeApiTruncationIndexForUserTurn(
    apiHistory: Content[],
    targetTurnIndex: number,
  ): number {
    const startIndex = this.#hasStartupContext(apiHistory) ? 2 : 0;

    if (targetTurnIndex === 0) {
      return startIndex;
    }

    let realUserPromptCount = 0;
    for (let i = startIndex; i < apiHistory.length; i++) {
      if (!this.#isUserTextContent(apiHistory[i]!)) {
        continue;
      }

      if (realUserPromptCount === targetTurnIndex) {
        return i;
      }

      realUserPromptCount += 1;
    }

    return -1;
  }

  #hasStartupContext(apiHistory: Content[]): boolean {
    if (apiHistory.length < 2) return false;
    const first = apiHistory[0];
    const second = apiHistory[1];
    if (first?.role !== 'user' || second?.role !== 'model') return false;
    return (
      second.parts?.some(
        (part) => 'text' in part && part.text === STARTUP_CONTEXT_MODEL_ACK,
      ) ?? false
    );
  }

  #isUserTextContent(content: Content): boolean {
    if (content.role !== 'user') return false;
    if (!content.parts || content.parts.length === 0) return false;

    const hasFunctionResponse = content.parts.some(
      (part) => 'functionResponse' in part,
    );
    if (hasFunctionResponse) return false;

    return content.parts.some((part) => 'text' in part && part.text);
  }

  async cancelPendingPrompt(): Promise<void> {
    const hadPrompt = !!this.pendingPrompt;
    const hadCron = !!this.cronAbortController;

    if (!hadPrompt && !hadCron) {
      throw new Error('Not currently generating');
    }

    if (this.pendingPrompt) {
      this.pendingPrompt.abort();
      this.pendingPrompt = null;
    }

    // Cancel any in-progress cron execution
    if (this.cronAbortController) {
      this.cronAbortController.abort();
      this.cronAbortController = null;
      this.cronQueue = [];
      this.cronProcessing = false;
    }

    // Stop scheduler and emit exit summary
    const scheduler = this.config.isCronEnabled()
      ? this.config.getCronScheduler()
      : null;
    if (scheduler) {
      const summary = scheduler.getExitSummary();
      scheduler.stop();
      if (summary) {
        await this.messageEmitter.emitAgentMessage(summary);
      }
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    // Install this prompt's AbortController before awaiting the previous
    // prompt, so that a session/cancel during the wait targets us.
    this.pendingPrompt?.abort();
    const pendingSend = new AbortController();
    this.pendingPrompt = pendingSend;

    // Abort any in-progress cron execution (user prompt takes priority)
    if (this.cronAbortController) {
      this.cronAbortController.abort();
      this.cronAbortController = null;
      this.cronQueue = [];
      this.cronProcessing = false;
    }
    if (this.cronCompletion) {
      try {
        await this.cronCompletion;
      } catch {
        // Expected: cron was aborted
      }
      this.cronCompletion = null;
    }

    // Wait for the previous prompt to finish so chat history is consistent.
    if (this.pendingPromptCompletion) {
      try {
        await this.pendingPromptCompletion;
      } catch {
        // Expected: previous prompt was cancelled or errored
      }
    }

    // Cancelled while waiting for the previous prompt to finish.
    if (pendingSend.signal.aborted) {
      return { stopReason: 'cancelled' };
    }

    // Track this prompt's completion for the next prompt to await
    let resolveCompletion!: () => void;
    this.pendingPromptCompletion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    try {
      const result = await this.#executePrompt(params, pendingSend);
      this.pendingPrompt = null;
      this.#startCronSchedulerIfNeeded();
      // Drain any cron prompts that queued while the prompt was active
      void this.#drainCronQueue();
      return result;
    } finally {
      resolveCompletion();
    }
  }

  async #executePrompt(
    params: PromptRequest,
    pendingSend: AbortController,
  ): Promise<PromptResponse> {
    return Storage.runWithRuntimeBaseDir(
      this.runtimeBaseDir,
      this.config.getWorkingDir(),
      async () => {
        // Increment turn counter for each user prompt
        this.turn += 1;

        const promptId = this.config.getSessionId() + '########' + this.turn;

        // Extract text from all text blocks to construct the full prompt text for logging
        const promptText = params.prompt
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join(' ');

        // Log user prompt
        logUserPrompt(
          this.config,
          new UserPromptEvent(
            promptText.length,
            promptId,
            this.config.getContentGeneratorConfig()?.authType,
            promptText,
          ),
        );

        // record user message for session management
        this.config.getChatRecordingService()?.recordUserMessage(promptText);

        // Check if the input contains a slash command
        // Extract text from the first text block if present
        const firstTextBlock = params.prompt.find(
          (block) => block.type === 'text',
        );
        const inputText = firstTextBlock?.text || '';

        let parts: Part[] | null;

        if (isSlashCommand(inputText)) {
          // Handle slash command in ACP mode using capability-based filtering
          const slashCommandResult = await handleSlashCommand(
            inputText,
            pendingSend,
            this.config,
            this.settings,
          );

          parts = await this.#processSlashCommandResult(
            slashCommandResult,
            params.prompt,
          );

          // If parts is null, the command was fully handled (e.g., /summary completed)
          // Return early without sending to the model
          if (parts === null) {
            return { stopReason: 'end_turn' };
          }
        } else {
          // Normal processing for non-slash commands
          parts = await this.#resolvePrompt(params.prompt, pendingSend.signal);
        }

        // Fire UserPromptSubmit hook through MessageBus (aligned with core path in client.ts)
        const hooksEnabled = !this.config.getDisableAllHooks?.();
        const messageBus = this.config.getMessageBus?.();
        if (
          hooksEnabled &&
          messageBus &&
          this.config.hasHooksForEvent?.('UserPromptSubmit')
        ) {
          const response = await messageBus.request<
            HookExecutionRequest,
            HookExecutionResponse
          >(
            {
              type: MessageBusType.HOOK_EXECUTION_REQUEST,
              eventName: 'UserPromptSubmit',
              input: {
                prompt: promptText,
              },
              signal: pendingSend.signal,
            },
            MessageBusType.HOOK_EXECUTION_RESPONSE,
          );
          const hookOutput = response.output
            ? createHookOutput('UserPromptSubmit', response.output)
            : undefined;

          if (
            hookOutput?.isBlockingDecision() ||
            hookOutput?.shouldStopExecution()
          ) {
            // Hook blocked the prompt - send notification to UI and return
            const blockReason =
              hookOutput?.getEffectiveReason() || 'No reason provided';
            await this.messageEmitter.emitAgentMessage(
              `🚫 **UserPromptSubmit blocked**: ${blockReason}`,
            );
            return { stopReason: 'end_turn' };
          }

          // Add additional context from hooks to the request
          const additionalContext = hookOutput?.getAdditionalContext();
          if (additionalContext) {
            parts = [...parts, { text: additionalContext }];
          }
        }

        // Prepend session-level system reminders (plan mode / subagent /
        // arena) so the model sees them, matching the behaviour of
        // `GeminiClient.sendMessageStream` in the CLI/TUI path. Without this,
        // plan mode in ACP has no effect because the model never learns it
        // should avoid edits (#1151).
        const systemReminders = await this.#buildInitialSystemReminders();
        if (systemReminders.length > 0) {
          parts = [...systemReminders, ...parts];
        }

        let nextMessage: Content | null = { role: 'user', parts };

        while (nextMessage !== null) {
          if (pendingSend.signal.aborted) {
            this.#getCurrentChat().addHistory(nextMessage);
            return { stopReason: 'cancelled' };
          }

          const functionCalls: FunctionCall[] = [];
          let usageMetadata: GenerateContentResponseUsageMetadata | null = null;
          const streamStartTime = Date.now();

          try {
            const sendResult = await this.#sendMessageStreamWithAutoCompression(
              promptId,
              nextMessage?.parts ?? [],
              pendingSend.signal,
            );
            if (!sendResult.responseStream) {
              this.#preserveUnsentMessageHistory(
                nextMessage,
                sendResult.stopReason === 'cancelled',
              );
              return { stopReason: sendResult.stopReason };
            }
            const responseStream = sendResult.responseStream;
            nextMessage = null;

            for await (const resp of responseStream) {
              if (pendingSend.signal.aborted) {
                return { stopReason: 'cancelled' };
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.candidates &&
                resp.value.candidates.length > 0
              ) {
                const candidate = resp.value.candidates[0];
                for (const part of candidate.content?.parts ?? []) {
                  if (!part.text) {
                    continue;
                  }

                  this.messageEmitter.emitMessage(
                    part.text,
                    'assistant',
                    part.thought,
                  );
                }
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.usageMetadata
              ) {
                usageMetadata = resp.value.usageMetadata;
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.functionCalls
              ) {
                functionCalls.push(...resp.value.functionCalls);
              }
            }
          } catch (error) {
            // Fire StopFailure hook (fire-and-forget, replaces Stop event for API errors)
            // Aligned with useGeminiStream.ts handleFinishedWithErrorEvent
            const errorStatus = getErrorStatus(error);
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const errorType = classifyApiError({
              message: errorMessage,
              status: errorStatus,
            });

            const hookSystem = this.config.getHookSystem?.();
            const hooksEnabledForStopFailure =
              !this.config.getDisableAllHooks?.();
            if (
              hooksEnabledForStopFailure &&
              hookSystem &&
              this.config.hasHooksForEvent?.('StopFailure')
            ) {
              // Fire-and-forget: don't wait for hook to complete
              hookSystem
                .fireStopFailureEvent(errorType, errorMessage)
                .catch((err) => {
                  debugLogger.warn(`StopFailure hook failed: ${err}`);
                });
            }

            if (errorStatus === 429) {
              throw new RequestError(
                429,
                'Rate limit exceeded. Try again later.',
              );
            }

            throw error;
          }

          if (usageMetadata) {
            this.#recordPromptTokenCount(usageMetadata);
            // Kick off rewrite in background (non-blocking, runs parallel to tools)
            if (this.messageRewriter) {
              this.messageRewriter.flushTurn(pendingSend.signal);
            }

            const durationMs = Date.now() - streamStartTime;
            await this.messageEmitter.emitUsageMetadata(
              usageMetadata,
              '',
              durationMs,
            );
          }

          if (functionCalls.length > 0) {
            const toolResponseParts = await this.runToolCalls(
              pendingSend.signal,
              promptId,
              functionCalls,
            );
            nextMessage = { role: 'user', parts: toolResponseParts };
          }
        }

        // Wait for any pending rewrite before returning
        if (this.messageRewriter) {
          await this.messageRewriter.waitForPendingRewrites();
        }

        // Fire Stop hook loop (aligned with core path in client.ts)
        // This is triggered after model response completes with no pending tool calls
        return this.#handleStopHookLoop(
          pendingSend,
          promptId,
          hooksEnabled,
          messageBus,
        );
      },
    );
  }

  /**
   * Handles the Stop hook iteration loop.
   * This method processes Stop hooks after a model response completes with no pending tool calls.
   * If a Stop hook requests continuation, it sends a follow-up message and loops back.
   * Maximum iterations (100) prevent infinite loops.
   *
   * @param pendingSend - The abort controller for the current prompt
   * @param promptId - The prompt ID for tracking
   * @param hooksEnabled - Whether hooks are enabled
   * @param messageBus - The MessageBus for hook communication (may be undefined)
   * @returns The ACP stop reason for the prompt.
   */
  async #handleStopHookLoop(
    pendingSend: AbortController,
    promptId: string,
    hooksEnabled: boolean,
    messageBus: MessageBus | undefined,
  ): Promise<{ stopReason: PromptResponse['stopReason'] }> {
    const MAX_STOP_HOOK_ITERATIONS = 100;
    let stopHookIterationCount = 0;
    let stopHookReasons: string[] = [];

    while (stopHookIterationCount < MAX_STOP_HOOK_ITERATIONS) {
      if (
        !hooksEnabled ||
        !messageBus ||
        pendingSend.signal.aborted ||
        !this.config.hasHooksForEvent?.('Stop')
      ) {
        return { stopReason: 'end_turn' };
      }

      // Get response text from the chat history
      const history = this.#getCurrentChat().getHistory();
      const lastModelMessage = history
        .filter((msg: Content) => msg.role === 'model')
        .pop();
      const responseText =
        lastModelMessage?.parts
          ?.filter((p: Part): p is { text: string } & Part => 'text' in p)
          .map((p: { text: string }) => p.text)
          .join('') || '[no response text]';

      const response = await messageBus.request<
        HookExecutionRequest,
        HookExecutionResponse
      >(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Stop',
          input: {
            stop_hook_active: true,
            last_assistant_message: responseText,
          },
          signal: pendingSend.signal,
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );

      // Check if aborted after hook execution
      if (pendingSend.signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      const hookOutput = response.output
        ? createHookOutput('Stop', response.output)
        : undefined;

      const stopOutput = hookOutput as StopHookOutput | undefined;

      // Emit system message if provided by hook
      if (stopOutput?.systemMessage) {
        await this.messageEmitter.emitAgentMessage(stopOutput.systemMessage);
      }

      // For Stop hooks, blocking/stop execution should force continuation
      if (
        stopOutput?.isBlockingDecision() ||
        stopOutput?.shouldStopExecution()
      ) {
        const continueReason = stopOutput.getEffectiveReason();

        // Track Stop hook iterations
        stopHookIterationCount++;
        stopHookReasons = [...stopHookReasons, continueReason];

        // Emit StopHookLoop event for iterations after the first one
        if (stopHookIterationCount > 1) {
          await this.messageEmitter.emitStopHookLoop(
            stopHookIterationCount,
            stopHookReasons,
            response.stopHookCount ?? 1,
          );
        }

        // Continue the conversation with the hook's reason
        const continueParts: Part[] = [{ text: continueReason }];
        let nextMessage: Content | null = {
          role: 'user',
          parts: continueParts,
        };

        // Process the follow-up message and any tool calls that result
        while (nextMessage !== null) {
          if (pendingSend.signal.aborted) {
            return { stopReason: 'cancelled' };
          }

          const functionCalls: FunctionCall[] = [];
          let usageMetadata: GenerateContentResponseUsageMetadata | null = null;
          const streamStartTime = Date.now();

          try {
            const continueSendResult =
              await this.#sendMessageStreamWithAutoCompression(
                promptId + '_stop_hook_' + stopHookIterationCount,
                nextMessage?.parts ?? [],
                pendingSend.signal,
                { skipCompression: stopHookIterationCount > 1 },
              );
            if (!continueSendResult.responseStream) {
              this.#preserveUnsentMessageHistory(
                nextMessage,
                continueSendResult.stopReason === 'cancelled',
              );
              return { stopReason: continueSendResult.stopReason };
            }
            const continueResponseStream = continueSendResult.responseStream;
            nextMessage = null;

            for await (const resp of continueResponseStream) {
              if (pendingSend.signal.aborted) {
                return { stopReason: 'cancelled' };
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.candidates &&
                resp.value.candidates.length > 0
              ) {
                const candidate = resp.value.candidates[0];
                for (const part of candidate.content?.parts ?? []) {
                  if (!part.text) continue;
                  this.messageEmitter.emitMessage(
                    part.text,
                    'assistant',
                    part.thought,
                  );
                }
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.usageMetadata
              ) {
                usageMetadata = resp.value.usageMetadata;
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.functionCalls
              ) {
                functionCalls.push(...resp.value.functionCalls);
              }
            }
          } catch (error) {
            // Fire StopFailure hook (fire-and-forget)
            const errorStatus = getErrorStatus(error);
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const errorType = classifyApiError({
              message: errorMessage,
              status: errorStatus,
            });

            const hookSystem = this.config.getHookSystem?.();
            const hooksEnabledForStopFailure =
              !this.config.getDisableAllHooks?.();
            if (
              hooksEnabledForStopFailure &&
              hookSystem &&
              this.config.hasHooksForEvent?.('StopFailure')
            ) {
              hookSystem
                .fireStopFailureEvent(errorType, errorMessage)
                .catch((err) => {
                  debugLogger.warn(`StopFailure hook failed: ${err}`);
                });
            }

            if (errorStatus === 429) {
              throw new RequestError(
                429,
                'Rate limit exceeded. Try again later.',
              );
            }

            throw error;
          }

          if (usageMetadata) {
            this.#recordPromptTokenCount(usageMetadata);
            const durationMs = Date.now() - streamStartTime;
            await this.messageEmitter.emitUsageMetadata(
              usageMetadata,
              '',
              durationMs,
            );
          }

          // Process tool calls from the follow-up message
          if (functionCalls.length > 0) {
            const toolResponseParts = await this.runToolCalls(
              pendingSend.signal,
              promptId,
              functionCalls,
            );
            nextMessage = { role: 'user', parts: toolResponseParts };
          }
        }

        // Loop continues to check Stop hook again after processing the follow-up
        continue;
      }

      // Stop hook allowed stopping, exit the loop
      break;
    }

    // If we exceeded max iterations, log a warning but still end gracefully
    if (stopHookIterationCount >= MAX_STOP_HOOK_ITERATIONS) {
      debugLogger.warn(
        `Stop hook loop reached maximum iterations (${MAX_STOP_HOOK_ITERATIONS}), forcing stop`,
      );
    }

    return { stopReason: 'end_turn' };
  }

  async sendUpdate(update: SessionUpdate): Promise<void> {
    const params: SessionNotification = {
      sessionId: this.sessionId,
      update,
    };

    await this.client.sessionUpdate(params);
  }

  #getCurrentChat(): GeminiChat {
    return this.config.getGeminiClient()!.getChat();
  }

  /**
   * Mirrors the core send path for ACP model sends.
   *
   * Attempts automatic chat compression first, checks the session token limit,
   * emits an ACP-visible notice when compression succeeds, and returns the ACP
   * stop reason when the provider send should be skipped because the request
   * was cancelled or the session token limit was exceeded.
   */
  async #sendMessageStreamWithAutoCompression(
    promptId: string,
    message: Part[],
    abortSignal: AbortSignal,
    options: { skipCompression?: boolean } = {},
  ): Promise<AutoCompressionSendResult> {
    const geminiClient = this.config.getGeminiClient()!;
    let compressionDiagnostic: string | null = null;
    let compressionInfo: ChatCompressionInfo | null = null;
    if (!options.skipCompression) {
      try {
        const compressed = await geminiClient.tryCompressChat(
          promptId,
          false,
          abortSignal,
        );
        compressionInfo = compressed;
        this.#recordCompressionTokenCount(compressed);
        if (compressed.compressionStatus === CompressionStatus.COMPRESSED) {
          compressionDiagnostic =
            `IMPORTANT: This conversation approached the input token limit for ${this.config.getModel()}. ` +
            `A compressed context will be sent for future messages (compressed from: ` +
            `${compressed.originalTokenCount ?? 'unknown'} to ` +
            `${compressed.newTokenCount ?? 'unknown'} tokens).`;
        }
      } catch (compressionError) {
        if (abortSignal.aborted || this.#isAbortError(compressionError)) {
          debugLogger.debug(`Auto-compression aborted for prompt ${promptId}`);
          return { responseStream: null, stopReason: 'cancelled' };
        }
        debugLogger.warn(
          `Auto-compression failed for prompt ${promptId}; proceeding without compression: ` +
            this.#formatError(compressionError),
        );
      }
    }

    if (abortSignal.aborted) {
      debugLogger.debug(`Auto-compression aborted for prompt ${promptId}`);
      return { responseStream: null, stopReason: 'cancelled' };
    }

    if (!compressionInfo) {
      this.#syncPromptTokenCountWithCurrentChat();
    }

    const sessionTokenLimit = this.config.getSessionTokenLimit();
    if (sessionTokenLimit > 0) {
      const lastPromptTokenCount =
        this.#getPostCompressionTokenCount(compressionInfo);
      if (lastPromptTokenCount > sessionTokenLimit) {
        debugLogger.warn(
          `Session token limit exceeded for prompt ${promptId}: ` +
            `${lastPromptTokenCount} > ${sessionTokenLimit}. Send dropped.`,
        );
        await this.#emitAgentDiagnosticMessageSafely(
          `Session token limit exceeded: ${lastPromptTokenCount} tokens > ${sessionTokenLimit} limit. ` +
            'Please start a new session or increase the sessionTokenLimit in your settings.json.',
          `Failed to emit token limit diagnostic for prompt ${promptId}`,
        );
        return { responseStream: null, stopReason: 'max_tokens' };
      }
    }

    if (compressionDiagnostic) {
      await this.#emitAgentDiagnosticMessageSafely(
        compressionDiagnostic,
        `Failed to emit compression notification for prompt ${promptId}`,
      );
    }

    if (abortSignal.aborted) {
      debugLogger.debug(
        `Send aborted after compression diagnostic for prompt ${promptId}`,
      );
      return { responseStream: null, stopReason: 'cancelled' };
    }

    const responseStream = await this.#getCurrentChat().sendMessageStream(
      this.config.getModel(),
      {
        message,
        config: {
          abortSignal,
        },
      },
      promptId,
    );
    return { responseStream };
  }

  #preserveUnsentMessageHistory(
    message: Content | null,
    preserveFullMessage: boolean,
  ): void {
    if (!message) return;

    if (preserveFullMessage) {
      this.#getCurrentChat().addHistory(message);
      return;
    }

    const functionResponseParts =
      message.parts?.filter(
        (part: Part) => 'functionResponse' in part && part.functionResponse,
      ) ?? [];
    const droppedParts =
      (message.parts?.length ?? 0) - functionResponseParts.length;
    if (droppedParts > 0) {
      debugLogger.debug(
        `Dropping ${droppedParts} non-functionResponse part(s) from unsent ACP message after send was skipped.`,
      );
    }
    if (functionResponseParts.length > 0) {
      this.#getCurrentChat().addHistory({
        ...message,
        parts: functionResponseParts,
      });
    }
  }

  #recordCompressionTokenCount(info: ChatCompressionInfo): void {
    this.#syncPromptTokenCountWithCurrentChat();
    const tokenCount = this.#extractCompressionTokenCount(info);
    if (tokenCount !== null && tokenCount > 0) {
      this.lastPromptTokenCount = tokenCount;
    }
  }

  #recordPromptTokenCount(
    usageMetadata: GenerateContentResponseUsageMetadata,
  ): void {
    this.#syncPromptTokenCountWithCurrentChat();
    const tokenCount =
      usageMetadata.promptTokenCount ?? usageMetadata.totalTokenCount;
    if (tokenCount !== undefined && tokenCount > 0) {
      this.lastPromptTokenCount = tokenCount;
    }
  }

  #getPostCompressionTokenCount(info: ChatCompressionInfo | null): number {
    const tokenCount = this.#extractCompressionTokenCount(info);
    if (tokenCount !== null) {
      return tokenCount;
    }

    return this.lastPromptTokenCount;
  }

  #extractCompressionTokenCount(
    info: ChatCompressionInfo | null,
  ): number | null {
    if (!info) {
      return null;
    }
    if (info.compressionStatus === CompressionStatus.COMPRESSED) {
      return info.newTokenCount > 0 ? info.newTokenCount : null;
    }
    const tokenCount = info.originalTokenCount ?? info.newTokenCount ?? null;
    if (tokenCount === 0 && info.compressionStatus === CompressionStatus.NOOP) {
      return null;
    }
    return tokenCount;
  }

  #syncPromptTokenCountWithCurrentChat(): void {
    const chat = this.#getCurrentChat();
    if (
      this.lastPromptTokenCountChat &&
      this.lastPromptTokenCountChat !== chat
    ) {
      this.lastPromptTokenCount = 0;
    }
    this.lastPromptTokenCountChat = chat;
  }

  #isAbortError(error: unknown): boolean {
    return (
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError') ||
      (typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: unknown }).name === 'AbortError')
    );
  }

  #formatError(error: unknown): string {
    if (error instanceof Error) {
      const parts = [error.message];
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause instanceof Error) {
        parts.push(`cause: ${cause.message}`);
      }
      const status = (error as Error & { status?: unknown }).status;
      if (status !== undefined) {
        parts.push(`status: ${String(status)}`);
      }
      return parts.join(' | ');
    }
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }

  async #emitAgentDiagnosticMessageSafely(
    text: string,
    failureContext: string,
  ): Promise<void> {
    try {
      await this.#emitAgentDiagnosticMessage(text);
    } catch (notifyError) {
      debugLogger.warn(`${failureContext}: ${this.#formatError(notifyError)}`);
    }
  }

  async #emitAgentDiagnosticMessage(text: string): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  /**
   * Starts the cron scheduler if cron is enabled and jobs exist.
   * The scheduler runs in the background, pushing fired prompts into
   * `cronQueue` and triggering `#drainCronQueue`.
   */
  #startCronSchedulerIfNeeded(): void {
    if (!this.config.isCronEnabled()) return;
    if (this.cronDisabledByTokenLimit) return;
    const scheduler = this.config.getCronScheduler();
    if (scheduler.size === 0) return;

    scheduler.start((job: { prompt: string }) => {
      if (this.cronDisabledByTokenLimit) return;
      this.cronQueue.push(job.prompt);
      void this.#drainCronQueue();
    });
  }

  /**
   * Processes queued cron prompts one at a time. Uses `cronProcessing`
   * as a mutex to prevent concurrent access to the chat.
   */
  async #drainCronQueue(): Promise<void> {
    if (this.cronProcessing) return;
    // Don't process cron while a user prompt is active — the queue will be
    // drained after the prompt completes (see end of prompt()).
    if (this.pendingPrompt) return;
    this.cronProcessing = true;

    let resolveCompletion!: () => void;
    this.cronCompletion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    try {
      while (this.cronQueue.length > 0) {
        const prompt = this.cronQueue.shift()!;
        await this.#executeCronPrompt(prompt);
      }
    } finally {
      this.cronProcessing = false;
      resolveCompletion();
      this.cronCompletion = null;

      // Stop scheduler if all jobs were deleted during execution
      if (this.config.isCronEnabled()) {
        const scheduler = this.config.getCronScheduler();
        if (scheduler.size === 0) {
          scheduler.stop();
        }
      }
    }
  }

  /**
   * Executes a single cron-fired prompt: echoes it as a user message with
   * `_meta.source='cron'`, streams the model response, and handles tool calls.
   */
  async #executeCronPrompt(prompt: string): Promise<void> {
    return Storage.runWithRuntimeBaseDir(
      this.runtimeBaseDir,
      this.config.getWorkingDir(),
      async () => {
        const ac = new AbortController();
        this.cronAbortController = ac;
        const promptId =
          this.config.getSessionId() + '########cron' + Date.now();

        try {
          // Echo the cron prompt as a user message so the client sees it
          await this.sendUpdate({
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: prompt },
            _meta: { source: 'cron' },
          });

          // Prepend session-level system reminders (same rationale as the
          // user-query path in #executePrompt).
          const cronReminders = await this.#buildInitialSystemReminders();
          let nextMessage: Content | null = {
            role: 'user',
            parts: [...cronReminders, { text: prompt }],
          };

          while (nextMessage !== null) {
            if (ac.signal.aborted) return;

            const functionCalls: FunctionCall[] = [];
            let usageMetadata: GenerateContentResponseUsageMetadata | null =
              null;
            const streamStartTime = Date.now();

            const sendResult = await this.#sendMessageStreamWithAutoCompression(
              promptId,
              nextMessage.parts ?? [],
              ac.signal,
            );
            if (!sendResult.responseStream) {
              this.#preserveUnsentMessageHistory(
                nextMessage,
                sendResult.stopReason === 'cancelled',
              );
              if (sendResult.stopReason === 'max_tokens') {
                this.#stopCronAfterTokenLimit();
              }
              return;
            }
            const responseStream = sendResult.responseStream;
            nextMessage = null;

            for await (const resp of responseStream) {
              if (ac.signal.aborted) return;

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.candidates &&
                resp.value.candidates.length > 0
              ) {
                const candidate = resp.value.candidates[0];
                for (const part of candidate.content?.parts ?? []) {
                  if (!part.text) continue;
                  this.messageEmitter.emitMessage(
                    part.text,
                    'assistant',
                    part.thought,
                  );
                }
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.usageMetadata
              ) {
                usageMetadata = resp.value.usageMetadata;
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.functionCalls
              ) {
                functionCalls.push(...resp.value.functionCalls);
              }
            }

            if (usageMetadata) {
              this.#recordPromptTokenCount(usageMetadata);
              // Kick off rewrite in background (non-blocking)
              if (this.messageRewriter) {
                this.messageRewriter.flushTurn(ac.signal);
              }
              const durationMs = Date.now() - streamStartTime;
              await this.messageEmitter.emitUsageMetadata(
                usageMetadata,
                '',
                durationMs,
              );
            }

            if (functionCalls.length > 0) {
              const toolResponseParts = await this.runToolCalls(
                ac.signal,
                promptId,
                functionCalls,
              );
              nextMessage = { role: 'user', parts: toolResponseParts };
            }
          }
        } catch (error) {
          if (ac.signal.aborted) return;
          debugLogger.error('Error processing cron prompt:', error);
          const msg = error instanceof Error ? error.message : String(error);
          await this.messageEmitter.emitAgentMessage(`[cron error] ${msg}`);
        } finally {
          if (this.cronAbortController === ac) {
            this.cronAbortController = null;
          }
        }
      },
    );
  }

  #stopCronAfterTokenLimit(): void {
    this.cronDisabledByTokenLimit = true;
    this.cronQueue = [];
    if (!this.config.isCronEnabled()) return;
    this.config.getCronScheduler().stop();
    void this.#emitAgentDiagnosticMessageSafely(
      'Cron jobs disabled for the rest of this session due to token limit. Restart the session to re-enable.',
      'Failed to emit cron-disabled diagnostic',
    );
  }

  async sendAvailableCommandsUpdate(): Promise<void> {
    const abortController = new AbortController();
    try {
      // Load commands available in ACP mode
      const slashCommands = await getAvailableCommands(
        this.config,
        abortController.signal,
        'acp',
      );

      // Convert SlashCommand[] to AvailableCommand[] format for ACP protocol.
      // Commands that accept arguments get input: { hint } so the client can
      // let users type arguments before submitting.  Commands with no argument
      // support get input: null so the client auto-submits them on selection.
      //
      // A command is considered to accept arguments when any of:
      //   - it is not a BUILT_IN command (skills, file commands, etc.)
      //   - it has a completion function
      //   - it declares an argumentHint
      //   - it has subCommands
      const availableCommands: AvailableCommand[] = slashCommands.map((cmd) => {
        const acceptsInput =
          cmd.kind !== CommandKind.BUILT_IN ||
          cmd.completion != null ||
          cmd.argumentHint != null ||
          (cmd.subCommands != null && cmd.subCommands.length > 0);
        return {
          name: cmd.name,
          description: cmd.description,
          input: acceptsInput ? { hint: cmd.argumentHint ?? '' } : null,
          _meta: {
            argumentHint: cmd.argumentHint,
            source: cmd.source,
            sourceLabel: cmd.sourceLabel,
            supportedModes: getEffectiveSupportedModes(cmd),
            subcommands: getCommandSubcommandNames(cmd),
            modelInvocable: cmd.modelInvocable === true,
          },
        };
      });

      let availableSkills: string[] | undefined;
      try {
        const skillManager = this.config.getSkillManager();
        if (skillManager) {
          const skills = await skillManager.listSkills();
          availableSkills = skills.map((skill) => skill.name);
        }
      } catch (error) {
        debugLogger.error('Error loading available skills:', error);
      }

      const update: SessionUpdate = {
        sessionUpdate: 'available_commands_update',
        availableCommands,
        ...(availableSkills
          ? {
              _meta: {
                availableSkills,
              },
            }
          : {}),
      };

      await this.sendUpdate(update);
    } catch (error) {
      // Log error but don't fail session creation
      debugLogger.error('Error sending available commands update:', error);
    }
  }

  /**
   * Requests permission from the client for a tool call.
   * Used by SubAgentTracker for sub-agent approval requests.
   */
  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.client.requestPermission(params);
  }

  /**
   * Sets the approval mode for the current session.
   * Maps ACP approval mode values to core ApprovalMode enum.
   */
  async setMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const modeMap: Record<ApprovalModeValue, ApprovalMode> = {
      plan: ApprovalMode.PLAN,
      default: ApprovalMode.DEFAULT,
      'auto-edit': ApprovalMode.AUTO_EDIT,
      yolo: ApprovalMode.YOLO,
    };

    const approvalMode = modeMap[params.modeId as ApprovalModeValue];
    this.config.setApprovalMode(approvalMode);
  }

  /**
   * Sets the model for the current session.
   * Validates the model ID and switches the model via Config.
   */
  async setModel(
    params: SetSessionModelRequest,
    options: { persistDefault?: boolean } = {},
  ): Promise<SetSessionModelResponse | void> {
    const rawModelId = params.modelId.trim();

    if (!rawModelId) {
      throw RequestError.invalidParams(undefined, 'modelId cannot be empty');
    }

    const parsed = parseAcpModelOption(rawModelId);
    const previousAuthType = this.config.getAuthType?.();
    const selectedAuthType = parsed.authType ?? previousAuthType;

    if (!selectedAuthType) {
      throw RequestError.invalidParams(
        undefined,
        `authType cannot be determined for modelId "${parsed.modelId}"`,
      );
    }

    await this.config.switchModel(
      selectedAuthType,
      parsed.modelId,
      selectedAuthType !== previousAuthType &&
        selectedAuthType === AuthType.QWEN_OAUTH
        ? { requireCachedCredentials: true }
        : undefined,
    );

    if (options.persistDefault ?? true) {
      const persistScope = getPersistScopeForModelSelection(this.settings);
      this.settings.setValue(persistScope, 'model.name', parsed.modelId);
      this.settings.setValue(
        persistScope,
        'security.auth.selectedType',
        selectedAuthType,
      );
    }
  }

  /**
   * Sends a current_mode_update notification to the client.
   * Called after the agent switches modes (e.g., from exit_plan_mode tool).
   */
  private async sendCurrentModeUpdateNotification(
    outcome: ToolConfirmationOutcome,
  ): Promise<void> {
    // Determine the new mode based on the approval outcome
    // This mirrors the logic in ExitPlanModeTool.onConfirm
    let newModeId: ApprovalModeValue;
    switch (outcome) {
      case ToolConfirmationOutcome.ProceedAlways:
        newModeId = 'auto-edit';
        break;
      case ToolConfirmationOutcome.RestorePrevious:
        // onConfirm has already restored the mode; read the actual current mode
        newModeId = this.config.getApprovalMode() as ApprovalModeValue;
        break;
      case ToolConfirmationOutcome.ProceedOnce:
      default:
        newModeId = 'default';
        break;
    }

    const update: SessionUpdate = {
      sessionUpdate: 'current_mode_update',
      currentModeId: newModeId,
    };

    await this.sendUpdate(update);
  }

  /**
   * Execute a batch of model-returned tool calls, running Agent calls
   * concurrently while keeping other tools sequential.
   *
   * Mirrors the partition logic in `coreToolScheduler.partitionToolCalls`:
   * consecutive Agent calls form a parallel batch (they spawn independent
   * sub-agents with no shared mutable state); any other tool forms its own
   * sequential batch to preserve the implicit ordering the model may rely
   * on. Response-part ordering matches the original `functionCalls` order.
   */
  private async runToolCalls(
    abortSignal: AbortSignal,
    promptId: string,
    functionCalls: FunctionCall[],
  ): Promise<Part[]> {
    type Batch = { concurrent: boolean; calls: FunctionCall[] };
    const batches: Batch[] = [];
    for (const fc of functionCalls) {
      const isAgent = fc.name === ToolNames.AGENT;
      const last = batches[batches.length - 1];
      if (isAgent && last?.concurrent) {
        last.calls.push(fc);
      } else {
        batches.push({ concurrent: isAgent, calls: [fc] });
      }
    }

    // Bounded-concurrency runner: matches core's `runConcurrently`
    // behaviour (`coreToolScheduler.ts:1506`), capped by
    // `QWEN_CODE_MAX_TOOL_CONCURRENCY` (default 10). Results are returned
    // in input order regardless of resolution order.
    const runBounded = async (calls: FunctionCall[]): Promise<Part[][]> => {
      const parsed = parseInt(
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] || '',
        10,
      );
      const maxConcurrency =
        Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
      const results: Part[][] = new Array(calls.length);
      const executing = new Set<Promise<void>>();
      for (let i = 0; i < calls.length; i++) {
        const idx = i;
        const p = this.runTool(abortSignal, promptId, calls[idx])
          .then((r) => {
            results[idx] = r;
          })
          .finally(() => {
            executing.delete(p);
          });
        executing.add(p);
        if (executing.size >= maxConcurrency) {
          await Promise.race(executing);
        }
      }
      await Promise.all(executing);
      return results;
    };

    const parts: Part[] = [];
    for (const batch of batches) {
      if (batch.concurrent && batch.calls.length > 1) {
        const results = await runBounded(batch.calls);
        for (const r of results) parts.push(...r);
      } else {
        for (const fc of batch.calls) {
          const r = await this.runTool(abortSignal, promptId, fc);
          parts.push(...r);
        }
      }
    }
    return parts;
  }

  /**
   * Assemble the per-turn system reminders the model needs to see at the
   * start of a user query or cron fire. Mirrors the subagent/plan/arena
   * branches in `GeminiClient.sendMessageStream` (`client.ts:848-878`) —
   * the ACP path bypasses that code, so without this helper plan mode is
   * silently inert (#1151) and subagent/arena sessions lose context.
   *
   * Scope note: the `relevantAutoMemory` reminder is intentionally NOT
   * included here. Managed auto-memory requires a prefetch pipeline that
   * lives in `GeminiClient`, and porting it into the ACP path is tracked
   * separately as part of the broader middleware-alignment work.
   */
  async #buildInitialSystemReminders(): Promise<Part[]> {
    const reminders: Part[] = [];

    const hasAgentTool = await this.config
      .getToolRegistry()
      .ensureTool(ToolNames.AGENT);
    const subagents = (await this.config.getSubagentManager().listSubagents())
      .filter((subagent) => subagent.level !== 'builtin')
      .map((subagent) => subagent.name);
    if (hasAgentTool && subagents.length > 0) {
      reminders.push({ text: getSubagentSystemReminder(subagents) });
    }

    if (this.config.getApprovalMode() === ApprovalMode.PLAN) {
      reminders.push({
        text: getPlanModeSystemReminder(this.config.getSdkMode?.()),
      });
    }

    const arenaManager = this.config.getArenaManager?.();
    if (arenaManager) {
      try {
        const sessionDir = arenaManager.getArenaSessionDir();
        const configPath = `${sessionDir}/config.json`;
        reminders.push({ text: getArenaSystemReminder(configPath) });
      } catch {
        // Arena config not yet initialized — skip (matches client.ts).
      }
    }

    return reminders;
  }

  private async runTool(
    abortSignal: AbortSignal,
    promptId: string,
    fc: FunctionCall,
  ): Promise<Part[]> {
    const callId = fc.id ?? `${fc.name}-${Date.now()}`;
    let args = (fc.args ?? {}) as Record<string, unknown>;

    const startTime = Date.now();

    const errorResponse = (error: Error) => {
      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
        function_name: fc.name ?? '',
        function_args: args,
        duration_ms: durationMs,
        status: 'error',
        success: false,
        error: error.message,
        tool_type:
          typeof tool !== 'undefined' && tool instanceof DiscoveredMCPTool
            ? 'mcp'
            : 'native',
      });

      return [
        {
          functionResponse: {
            id: callId,
            name: fc.name ?? '',
            response: { error: error.message },
          },
        },
      ];
    };

    const earlyErrorResponse = async (
      error: Error,
      toolName = fc.name ?? 'unknown_tool',
    ) => {
      if (toolName !== ToolNames.TODO_WRITE) {
        await this.toolCallEmitter.emitError(callId, toolName, error);
      }

      const errorParts = errorResponse(error);
      this.config.getChatRecordingService()?.recordToolResult(errorParts, {
        callId,
        status: 'error',
        resultDisplay: undefined,
        error,
        errorType: undefined,
      });
      return errorParts;
    };

    if (!fc.name) {
      return earlyErrorResponse(new Error('Missing function name'));
    }

    const toolRegistry = this.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name as string);

    if (!tool) {
      return earlyErrorResponse(
        new Error(`Tool "${fc.name}" not found in registry.`),
      );
    }

    // ---- L1: Tool enablement check ----
    const pm = this.config.getPermissionManager?.();
    if (pm && !(await pm.isToolEnabled(fc.name as string))) {
      return earlyErrorResponse(
        new Error(
          `Qwen Code requires permission to use "${fc.name}", but that permission was declined.`,
        ),
        fc.name,
      );
    }

    // Detect TodoWriteTool early - route to plan updates instead of tool_call events
    const isTodoWriteTool = tool.name === ToolNames.TODO_WRITE;
    const isAgentTool = tool.name === ToolNames.AGENT;
    const isExitPlanModeTool = tool.name === ToolNames.EXIT_PLAN_MODE;

    // Track cleanup functions for sub-agent event listeners
    let subAgentCleanupFunctions: Array<() => void> = [];

    // Generate tool_use_id for hook tracking (aligned with core path)
    const toolUseId = generateToolUseId();

    // Get approval mode for hook context (defined outside try for catch block access)
    const approvalMode = this.config.getApprovalMode();

    try {
      const invocation = tool.build(args);

      // Production AgentTool always initializes `eventEmitter` on its
      // invocation (`agent.ts:392`). Be defensive about the `undefined`
      // case too so an incomplete/custom AgentTool invocation degrades
      // gracefully (no sub-agent event forwarding) instead of throwing
      // inside SubAgentTracker.setup — the `'eventEmitter' in invocation`
      // key-presence check passed for `{ eventEmitter: undefined }` and
      // the ensuing `eventEmitter.on(...)` blew up.
      const taskEventEmitter = (
        invocation as {
          eventEmitter?: AgentEventEmitter;
        }
      ).eventEmitter;
      if (isAgentTool && taskEventEmitter) {
        // Extract subagent metadata from AgentTool call
        const parentToolCallId = callId;
        const subagentType = (args['subagent_type'] as string) ?? '';

        // Create a SubAgentTracker for this tool execution
        const subSubAgentTracker = new SubAgentTracker(
          this,
          this.client,
          parentToolCallId,
          subagentType,
        );

        // Set up sub-agent tool tracking
        subAgentCleanupFunctions = subSubAgentTracker.setup(
          taskEventEmitter,
          abortSignal,
        );
      }

      // L3→L4→L5 Permission Flow (aligned with coreToolScheduler)
      //
      // L3: Tool's intrinsic default permission
      // L4: PermissionManager rule override
      // L5: ApprovalMode override (YOLO / AUTO_EDIT / PLAN)
      //
      // AUTO_EDIT auto-approval is handled HERE, same as coreToolScheduler.
      // The VS Code extension is just a UI layer for requestPermission.
      const isAskUserQuestionTool = fc.name === ToolNames.ASK_USER_QUESTION;

      // ---- L3→L4: Shared permission flow ----
      const toolParams = invocation.params as Record<string, unknown>;
      const flowResult = await evaluatePermissionFlow(
        this.config,
        invocation,
        fc.name,
        toolParams,
      );
      const { finalPermission, pmForcedAsk, pmCtx, denyMessage } = flowResult;

      // ---- L5: ApprovalMode overrides ----
      const isPlanMode = approvalMode === ApprovalMode.PLAN;

      if (finalPermission === 'deny') {
        return earlyErrorResponse(
          new Error(denyMessage ?? `Tool "${fc.name}" is denied.`),
          fc.name,
        );
      }

      let didRequestPermission = false;
      let confirmationDetails: ToolCallConfirmationDetails | undefined;

      if (needsConfirmation(finalPermission, approvalMode, fc.name)) {
        confirmationDetails =
          await invocation.getConfirmationDetails(abortSignal);

        // Centralised rule injection (for display and persistence)
        injectPermissionRulesIfMissing(confirmationDetails, pmCtx);

        if (
          isPlanModeBlocked(
            isPlanMode,
            isExitPlanModeTool,
            isAskUserQuestionTool,
            confirmationDetails,
          )
        ) {
          return earlyErrorResponse(
            new Error(
              `Plan mode is active. The tool "${fc.name}" cannot be executed because it modifies the system. ` +
                'Please use the exit_plan_mode tool to present your plan and exit plan mode before making changes.',
            ),
            fc.name,
          );
        }

        const messageBus = this.config.getMessageBus?.();
        const hooksEnabled = !this.config.getDisableAllHooks?.();
        let hookHandled = false;

        if (hooksEnabled && messageBus) {
          const hookResult = await firePermissionRequestHook(
            messageBus,
            fc.name,
            args,
            String(approvalMode),
          );

          if (hookResult.hasDecision) {
            hookHandled = true;
            if (hookResult.shouldAllow) {
              if (hookResult.updatedInput) {
                args = hookResult.updatedInput;
                invocation.params =
                  hookResult.updatedInput as typeof invocation.params;
              }

              await confirmationDetails.onConfirm(
                ToolConfirmationOutcome.ProceedOnce,
              );
            } else {
              return earlyErrorResponse(
                new Error(
                  hookResult.denyMessage ||
                    `Permission denied by hook for "${fc.name}"`,
                ),
                fc.name,
              );
            }
          }
        }

        // AUTO_EDIT mode: auto-approve edit and info tools
        // (same as coreToolScheduler L5 — NOT delegated to the extension)
        if (
          approvalMode === ApprovalMode.AUTO_EDIT &&
          (confirmationDetails.type === 'edit' ||
            confirmationDetails.type === 'info')
        ) {
          // Auto-approve, skip requestPermission.
          // didRequestPermission stays false → emitStart below.
        } else if (!hookHandled) {
          // Show permission dialog via ACP requestPermission
          didRequestPermission = true;
          const content = buildPermissionRequestContent(confirmationDetails);

          // Map tool kind, using switch_mode for exit_plan_mode per ACP spec
          const mappedKind = this.toolCallEmitter.mapToolKind(
            tool.kind,
            fc.name,
          );

          if (hooksEnabled && messageBus) {
            void fireNotificationHook(
              messageBus,
              `Qwen Code needs your permission to use ${fc.name}`,
              NotificationType.PermissionPrompt,
              'Permission needed',
            );
          }

          const params: RequestPermissionRequest = {
            sessionId: this.sessionId,
            options: toPermissionOptions(confirmationDetails, pmForcedAsk),
            toolCall: {
              toolCallId: callId,
              status: 'pending',
              title: invocation.getDescription(),
              content,
              locations: invocation.toolLocations(),
              kind: mappedKind,
              rawInput: args,
            },
          };

          const output = (await this.client.requestPermission(
            params,
          )) as RequestPermissionResponse & {
            answers?: Record<string, string>;
          };
          const outcome =
            output.outcome.outcome === 'cancelled'
              ? ToolConfirmationOutcome.Cancel
              : z
                  .nativeEnum(ToolConfirmationOutcome)
                  .parse(output.outcome.optionId);

          await confirmationDetails.onConfirm(outcome, {
            answers: output.answers,
          });

          // Persist permission rules when user explicitly chose "Always Allow".
          // This branch is only reached for tools that went through
          // requestPermission (user saw dialog and made a choice).
          // AUTO_EDIT auto-approved tools never reach here.
          if (
            outcome === ToolConfirmationOutcome.ProceedAlways ||
            outcome === ToolConfirmationOutcome.ProceedAlwaysProject ||
            outcome === ToolConfirmationOutcome.ProceedAlwaysUser
          ) {
            await persistPermissionOutcome(
              outcome,
              confirmationDetails,
              this.config.getOnPersistPermissionRule?.(),
              this.config.getPermissionManager?.(),
              { answers: output.answers },
            );
          }

          // After exit_plan_mode confirmation, send current_mode_update
          if (
            isExitPlanModeTool &&
            outcome !== ToolConfirmationOutcome.Cancel
          ) {
            await this.sendCurrentModeUpdateNotification(outcome);
          }

          // After edit tool ProceedAlways, notify the client about mode change
          if (
            confirmationDetails.type === 'edit' &&
            outcome === ToolConfirmationOutcome.ProceedAlways
          ) {
            await this.sendCurrentModeUpdateNotification(outcome);
          }

          switch (outcome) {
            case ToolConfirmationOutcome.Cancel:
              return errorResponse(
                new Error(`Tool "${fc.name}" was canceled by the user.`),
              );
            case ToolConfirmationOutcome.ProceedOnce:
            case ToolConfirmationOutcome.ProceedAlways:
            case ToolConfirmationOutcome.ProceedAlwaysProject:
            case ToolConfirmationOutcome.ProceedAlwaysUser:
            case ToolConfirmationOutcome.ProceedAlwaysServer:
            case ToolConfirmationOutcome.ProceedAlwaysTool:
            case ToolConfirmationOutcome.ModifyWithEditor:
            case ToolConfirmationOutcome.RestorePrevious:
              break;
            default: {
              const resultOutcome: never = outcome;
              throw new Error(`Unexpected: ${resultOutcome}`);
            }
          }
        }
      }

      if (!didRequestPermission && !isTodoWriteTool) {
        // Auto-approved (L3 allow / L4 PM allow / L5 YOLO|AUTO_EDIT)
        // → emit tool_call start notification
        const startParams: ToolCallStartParams = {
          callId,
          toolName: fc.name,
          args,
          status: 'in_progress',
        };
        await this.toolCallEmitter.emitStart(startParams);
      }

      // Fire PreToolUse hook (aligned with core path in coreToolScheduler.ts)
      const hooksEnabledForTool = !this.config.getDisableAllHooks?.();
      const messageBusForTool = this.config.getMessageBus?.();
      const permissionMode = String(approvalMode);

      if (hooksEnabledForTool && messageBusForTool) {
        const preHookResult = await firePreToolUseHook(
          messageBusForTool,
          fc.name,
          args,
          toolUseId,
          permissionMode,
          abortSignal,
        );

        if (!preHookResult.shouldProceed) {
          // Hook blocked the tool execution - send notification to UI
          const blockReason =
            preHookResult.blockReason || 'Blocked by PreToolUse hook';
          await this.messageEmitter.emitAgentMessage(
            `🚫 **PreToolUse blocked**: ${fc.name} - ${blockReason}`,
          );
          return earlyErrorResponse(new Error(blockReason), fc.name);
        }

        // Add additional context from PreToolUse hook if provided
        // Note: This context would need to be passed to the tool invocation
        // For now, we just log it as the tool execution proceeds
        if (preHookResult.additionalContext) {
          debugLogger.debug(
            `PreToolUse hook additional context for ${fc.name}: ${preHookResult.additionalContext}`,
          );
        }
      }

      const toolResult: ToolResult = await invocation.execute(abortSignal);

      // Clean up event listeners
      subAgentCleanupFunctions.forEach((cleanup) => cleanup());

      // Create response parts first (needed for emitResult and recordToolResult)
      const responseParts = convertToFunctionResponse(
        fc.name,
        callId,
        toolResult.llmContent,
      );

      // Fire PostToolUse hook on successful execution (aligned with core path)
      if (hooksEnabledForTool && messageBusForTool && !toolResult.error) {
        // Use the same response shape as core (llmContent/returnDisplay)
        const toolResponse = {
          llmContent: toolResult.llmContent,
          returnDisplay: toolResult.returnDisplay,
        };
        const postHookResult = await firePostToolUseHook(
          messageBusForTool,
          fc.name,
          args,
          toolResponse,
          toolUseId,
          permissionMode,
          abortSignal,
        );

        // If hook indicates to stop, return an error response
        if (postHookResult.shouldStop) {
          const stopMessage =
            postHookResult.stopReason ||
            'Execution stopped by PostToolUse hook';
          debugLogger.info(
            `PostToolUse hook requested stop for ${fc.name}: ${stopMessage}`,
          );
          return earlyErrorResponse(new Error(stopMessage), fc.name);
        }

        // Add additional context from PostToolUse hook if provided
        if (postHookResult.additionalContext) {
          // Append additional context to the tool response
          const contextPart = { text: postHookResult.additionalContext };
          responseParts.push(contextPart);
        }
      } else if (hooksEnabledForTool && messageBusForTool && toolResult.error) {
        // Fire PostToolUseFailure hook when tool returns an error (aligned with core path)
        const failureHookResult = await firePostToolUseFailureHook(
          messageBusForTool,
          toolUseId,
          fc.name ?? 'unknown_tool',
          args,
          toolResult.error.message,
          false, // not an interrupt
          permissionMode,
          abortSignal,
        );

        // Log additional context if provided
        if (failureHookResult.additionalContext) {
          debugLogger.debug(
            `PostToolUseFailure hook additional context for ${fc.name}: ${failureHookResult.additionalContext}`,
          );
        }
      }

      // Handle TodoWriteTool: extract todos and send plan update
      if (isTodoWriteTool) {
        const todos = this.planEmitter.extractTodos(
          toolResult.returnDisplay,
          args,
        );

        // Match original logic: emit plan if todos.length > 0 OR if args had todos
        if ((todos && todos.length > 0) || Array.isArray(args['todos'])) {
          await this.planEmitter.emitPlan(todos ?? []);
        }

        // Skip tool_call_update event for TodoWriteTool
        // Still log and return function response for LLM
      } else {
        // Normal tool handling: emit result using ToolCallEmitter
        // Convert toolResult.error to Error type if present
        const error = toolResult.error
          ? new Error(toolResult.error.message)
          : undefined;

        await this.toolCallEmitter.emitResult({
          callId,
          toolName: fc.name,
          args,
          message: responseParts,
          resultDisplay: toolResult.returnDisplay,
          error,
          success: !toolResult.error,
        });
      }

      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        function_name: fc.name,
        function_args: args,
        duration_ms: durationMs,
        status: 'success',
        success: true,
        prompt_id: promptId,
        tool_type:
          typeof tool !== 'undefined' && tool instanceof DiscoveredMCPTool
            ? 'mcp'
            : 'native',
      });

      // Record tool result for session management
      this.config.getChatRecordingService()?.recordToolResult(responseParts, {
        callId,
        status: 'success',
        resultDisplay: toolResult.returnDisplay,
        error: undefined,
        errorType: undefined,
      });

      return responseParts;
    } catch (e) {
      // Ensure cleanup on error
      subAgentCleanupFunctions.forEach((cleanup) => cleanup());

      const error = e instanceof Error ? e : new Error(String(e));

      // Fire PostToolUseFailure hook (aligned with core path in coreToolScheduler.ts)
      const hooksEnabledForError = !this.config.getDisableAllHooks?.();
      const messageBusForError = this.config.getMessageBus?.();
      const isInterrupt = abortSignal.aborted;

      if (hooksEnabledForError && messageBusForError) {
        const failureHookResult = await firePostToolUseFailureHook(
          messageBusForError,
          toolUseId,
          fc.name ?? 'unknown_tool',
          args,
          error.message,
          isInterrupt,
          String(approvalMode),
          abortSignal,
        );

        // Log additional context if provided
        if (failureHookResult.additionalContext) {
          debugLogger.debug(
            `PostToolUseFailure hook additional context for ${fc.name}: ${failureHookResult.additionalContext}`,
          );
        }
      }

      // Use ToolCallEmitter for error handling
      await this.toolCallEmitter.emitError(
        callId,
        fc.name ?? 'unknown_tool',
        error,
      );

      // Record tool error for session management
      const errorParts = [
        {
          functionResponse: {
            id: callId,
            name: fc.name ?? '',
            response: { error: error.message },
          },
        },
      ];
      this.config.getChatRecordingService()?.recordToolResult(errorParts, {
        callId,
        status: 'error',
        resultDisplay: undefined,
        error,
        errorType: undefined,
      });

      return errorResponse(error);
    }
  }

  /**
   * Processes the result of a slash command execution.
   *
   * Supported result types in ACP mode:
   * - submit_prompt: Submits content to the model
   * - stream_messages: Streams multiple messages to the client (ACP-specific)
   * - unsupported: Command cannot be executed in ACP mode
   * - no_command: No command was found, use original prompt
   *
   * Note: 'message' type is not supported in ACP mode - commands should use
   * 'stream_messages' instead for consistent async handling.
   *
   * @param result The result from handleSlashCommand
   * @param originalPrompt The original prompt blocks
   * @returns Parts to use for the prompt, or null if command was handled without needing model interaction
   */
  async #processSlashCommandResult(
    result: NonInteractiveSlashCommandResult,
    originalPrompt: ContentBlock[],
  ): Promise<Part[] | null> {
    switch (result.type) {
      case 'submit_prompt':
        // Command wants to submit a prompt to the model
        // Convert PartListUnion to Part[]
        return normalizePartList(result.content);

      case 'message': {
        if (result.messageType === 'error') {
          // Throw error to stop execution
          throw new Error(result.content || 'Slash command failed.');
        }
        // Emit the message as an agent message chunk so Zed renders it in the
        // chat UI. extNotification only goes to the ACP debug log and is not
        // rendered by Zed.
        // Replace bare \n with Markdown hard line-breaks (two trailing spaces)
        // so Zed's Markdown renderer preserves the line structure.
        const rendered = (result.content || '').replace(/\n/g, '  \n');
        await this.messageEmitter.emitAgentMessage(rendered);
        // Write a system/slash_command record so history replay on restart can
        // re-emit this message. system records are skipped by
        // buildApiHistoryFromConversation, so this won't pollute model context.
        this.config.getChatRecordingService()?.recordSlashCommand({
          phase: 'result',
          rawCommand: originalPrompt
            .filter((b) => b.type === 'text')
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join(' '),
          outputHistoryItems: [
            { type: 'assistant', text: result.content || '' },
          ],
        });
        return null;
      }

      case 'stream_messages': {
        // Command returns multiple messages via async generator (ACP-preferred)
        // Stream all messages to the client as agent message chunks.
        const chunks: string[] = [];
        for await (const msg of result.messages) {
          if (msg.messageType === 'error') {
            throw new Error(msg.content || 'Slash command failed.');
          }
          await this.messageEmitter.emitAgentMessage(
            (msg.content || '').replace(/\n/g, '  \n'),
          );
          chunks.push(msg.content || '');
        }
        // Write a system/slash_command record for history replay (same reason as
        // 'message' case — system records are invisible to model history).
        if (chunks.length > 0) {
          this.config.getChatRecordingService()?.recordSlashCommand({
            phase: 'result',
            rawCommand: originalPrompt
              .filter((b) => b.type === 'text')
              .map((b) => (b.type === 'text' ? b.text : ''))
              .join(' '),
            outputHistoryItems: [
              { type: 'assistant', text: chunks.join('\n') },
            ],
          });
        }

        // All messages sent successfully, return null to indicate command was handled
        return null;
      }

      case 'unsupported': {
        // Command returned an unsupported result type
        const unsupportedError = `Slash command not supported in ACP integration: ${result.reason}`;
        throw new Error(unsupportedError);
      }

      case 'no_command':
        // No command was found or executed, resolve the original prompt
        // through the standard path that handles all block types
        return this.#resolvePrompt(
          originalPrompt,
          new AbortController().signal,
        );

      default: {
        // Exhaustiveness check
        const _exhaustive: never = result;
        const unknownError = `Unknown slash command result type: ${(_exhaustive as NonInteractiveSlashCommandResult).type}`;
        throw new Error(unknownError);
      }
    }
  }

  async #resolvePrompt(
    message: ContentBlock[],
    abortSignal: AbortSignal,
  ): Promise<Part[]> {
    const FILE_URI_SCHEME = 'file://';

    const embeddedContext: EmbeddedResourceResource[] = [];

    const parts = message.map((part) => {
      switch (part.type) {
        case 'text':
          return { text: part.text };
        case 'image':
        case 'audio':
          return {
            inlineData: {
              mimeType: part.mimeType,
              data: part.data,
            },
          };
        case 'resource_link': {
          if (part.uri.startsWith(FILE_URI_SCHEME)) {
            return {
              fileData: {
                mimeData: part.mimeType,
                name: part.name,
                fileUri: part.uri.slice(FILE_URI_SCHEME.length),
              },
            };
          } else {
            return { text: `@${part.uri}` };
          }
        }
        case 'resource': {
          embeddedContext.push(part.resource);
          return { text: `@${part.resource.uri}` };
        }
        default: {
          const unreachable: never = part;
          throw new Error(`Unexpected chunk type: '${unreachable}'`);
        }
      }
    });

    const atPathCommandParts = parts.filter((part) => 'fileData' in part);

    if (atPathCommandParts.length === 0 && embeddedContext.length === 0) {
      return parts;
    }

    // Extract paths from @ commands - pass directly to readManyFiles without filtering
    // since this is user-triggered behavior, not LLM-triggered
    const pathSpecsToRead: string[] = atPathCommandParts.map(
      (part) => part.fileData!.fileUri,
    );

    // Construct the initial part of the query for the LLM
    let initialQueryText = '';
    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      if ('text' in chunk) {
        initialQueryText += chunk.text;
      } else if ('fileData' in chunk) {
        const pathName = chunk.fileData!.fileUri;
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ')
        ) {
          initialQueryText += ' ';
        }
        initialQueryText += `@${pathName}`;
      }
    }

    const processedQueryParts: Part[] = [];

    // Read files using readManyFiles utility
    if (pathSpecsToRead.length > 0) {
      const readResult = await readManyFiles(this.config, {
        paths: pathSpecsToRead,
        signal: abortSignal,
      });

      const contentParts = Array.isArray(readResult.contentParts)
        ? readResult.contentParts
        : [readResult.contentParts];

      // Add initial query text first
      processedQueryParts.push({ text: initialQueryText });

      // Then add content parts (preserving binary files as inlineData)
      for (const part of contentParts) {
        if (typeof part === 'string') {
          processedQueryParts.push({ text: part });
        } else {
          processedQueryParts.push(part);
        }
      }
    } else if (embeddedContext.length > 0) {
      // No @path files to read, but we have embedded context
      processedQueryParts.push({ text: initialQueryText.trim() });
    } else {
      // No @path files found
      processedQueryParts.push({ text: initialQueryText.trim() });
    }

    // Process embedded context from resource blocks
    for (const contextPart of embeddedContext) {
      // Type guard for text resources
      if ('text' in contextPart && contextPart.text) {
        processedQueryParts.push({
          text: `File: ${contextPart.uri}\n${contextPart.text}`,
        });
      }
      // Type guard for blob resources
      if ('blob' in contextPart && contextPart.blob) {
        processedQueryParts.push({
          inlineData: {
            mimeType: contextPart.mimeType ?? 'application/octet-stream',
            data: contextPart.blob,
          },
        });
      }
    }

    return processedQueryParts;
  }

  debug(msg: string): void {
    if (this.config.getDebugMode()) {
      debugLogger.warn(msg);
    }
  }
}
