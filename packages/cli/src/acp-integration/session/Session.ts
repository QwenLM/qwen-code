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
} from '@qwen-code/qwen-code-core';
import {
  AuthType,
  ApprovalMode,
  convertToFunctionResponse,
  createDebugLogger,
  DiscoveredMCPTool,
  StreamEventType,
  ToolConfirmationOutcome,
  logToolCall,
  logUserPrompt,
  getErrorStatus,
  AgentTool,
  UserPromptEvent,
  ExitPlanModeTool,
  readManyFiles,
  Storage,
  ToolNames,
  buildPermissionCheckContext,
  evaluatePermissionRules,
  fireNotificationHook,
  firePermissionRequestHook,
  injectPermissionRulesIfMissing,
  NotificationType,
  persistPermissionOutcome,
} from '@qwen-code/qwen-code-core';

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
import { parseAcpModelOption } from '../../utils/acpModelUtils.js';

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

const debugLogger = createDebugLogger('SESSION');

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

  // Modular components
  private readonly historyReplayer: HistoryReplayer;
  private readonly toolCallEmitter: ToolCallEmitter;
  private readonly planEmitter: PlanEmitter;
  private readonly messageEmitter: MessageEmitter;

  // Implement SessionContext interface
  readonly sessionId: string;

  constructor(
    id: string,
    private readonly chat: GeminiChat,
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
   * Replays conversation history to the client using modular components.
   * Delegates to HistoryReplayer for consistent event emission.
   */
  async replayHistory(records: ChatRecord[]): Promise<void> {
    await this.historyReplayer.replay(records);
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

        const chat = this.chat;
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
          // Handle slash command - uses default allowed commands (init, summary, compress)
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

        let nextMessage: Content | null = { role: 'user', parts };

        while (nextMessage !== null) {
          if (pendingSend.signal.aborted) {
            chat.addHistory(nextMessage);
            return { stopReason: 'cancelled' };
          }

          const functionCalls: FunctionCall[] = [];
          let usageMetadata: GenerateContentResponseUsageMetadata | null = null;
          const streamStartTime = Date.now();

          try {
            const responseStream = await chat.sendMessageStream(
              this.config.getModel(),
              {
                message: nextMessage?.parts ?? [],
                config: {
                  abortSignal: pendingSend.signal,
                },
              },
              promptId,
            );
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
            if (getErrorStatus(error) === 429) {
              throw new RequestError(
                429,
                'Rate limit exceeded. Try again later.',
              );
            }

            throw error;
          }

          if (usageMetadata) {
            const durationMs = Date.now() - streamStartTime;
            await this.messageEmitter.emitUsageMetadata(
              usageMetadata,
              '',
              durationMs,
            );
          }

          if (functionCalls.length > 0) {
            const toolResponseParts: Part[] = [];

            for (const fc of functionCalls) {
              const response = await this.runTool(
                pendingSend.signal,
                promptId,
                fc,
              );
              toolResponseParts.push(...response);
            }

            nextMessage = { role: 'user', parts: toolResponseParts };
          }
        }
        return { stopReason: 'end_turn' };
      },
    );
  }

  async sendUpdate(update: SessionUpdate): Promise<void> {
    const params: SessionNotification = {
      sessionId: this.sessionId,
      update,
    };

    await this.client.sessionUpdate(params);
  }

  /**
   * Starts the cron scheduler if cron is enabled and jobs exist.
   * The scheduler runs in the background, pushing fired prompts into
   * `cronQueue` and triggering `#drainCronQueue`.
   */
  #startCronSchedulerIfNeeded(): void {
    if (!this.config.isCronEnabled()) return;
    const scheduler = this.config.getCronScheduler();
    if (scheduler.size === 0) return;

    scheduler.start((job: { prompt: string }) => {
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

          let nextMessage: Content | null = {
            role: 'user',
            parts: [{ text: prompt }],
          };

          while (nextMessage !== null) {
            if (ac.signal.aborted) return;

            const functionCalls: FunctionCall[] = [];
            let usageMetadata: GenerateContentResponseUsageMetadata | null =
              null;
            const streamStartTime = Date.now();

            const responseStream = await this.chat.sendMessageStream(
              this.config.getModel(),
              {
                message: nextMessage.parts ?? [],
                config: { abortSignal: ac.signal },
              },
              promptId,
            );
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
              const durationMs = Date.now() - streamStartTime;
              await this.messageEmitter.emitUsageMetadata(
                usageMetadata,
                '',
                durationMs,
              );
            }

            if (functionCalls.length > 0) {
              const toolResponseParts: Part[] = [];
              for (const fc of functionCalls) {
                const response = await this.runTool(ac.signal, promptId, fc);
                toolResponseParts.push(...response);
              }
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

  async sendAvailableCommandsUpdate(): Promise<void> {
    const abortController = new AbortController();
    try {
      // Use default allowed commands from getAvailableCommands
      const slashCommands = await getAvailableCommands(
        this.config,
        abortController.signal,
      );

      // Convert SlashCommand[] to AvailableCommand[] format for ACP protocol
      const availableCommands: AvailableCommand[] = slashCommands.map(
        (cmd) => ({
          name: cmd.name,
          description: cmd.description,
          input: null,
        }),
      );

      const update: SessionUpdate = {
        sessionUpdate: 'available_commands_update',
        availableCommands,
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

  private async resolveIdeDiffForOutcome(
    confirmationDetails: ToolCallConfirmationDetails,
    outcome: ToolConfirmationOutcome,
  ): Promise<void> {
    if (
      confirmationDetails.type !== 'edit' ||
      !confirmationDetails.ideConfirmation
    ) {
      return;
    }

    const { IdeClient } = await import('@qwen-code/qwen-code-core');
    const ideClient = await IdeClient.getInstance();
    const cliOutcome =
      outcome === ToolConfirmationOutcome.Cancel ? 'rejected' : 'accepted';
    await ideClient.resolveDiffFromCli(
      confirmationDetails.filePath,
      cliOutcome as 'accepted' | 'rejected',
    );
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
      await this.toolCallEmitter.emitError(callId, toolName, error);

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
          `proto requires permission to use "${fc.name}", but that permission was declined.`,
        ),
        fc.name,
      );
    }

    // TodoWriteTool replaced by task management tools; task tools emit as regular tool_call events.
    const isTodoWriteTool = false;
    const isAgentTool = tool.name === AgentTool.Name;
    const isExitPlanModeTool = tool.name === ExitPlanModeTool.Name;

    // Track cleanup functions for sub-agent event listeners
    let subAgentCleanupFunctions: Array<() => void> = [];

    try {
      const invocation = tool.build(args);

      if (isAgentTool && 'eventEmitter' in invocation) {
        // Access eventEmitter from AgentTool invocation
        const taskEventEmitter = (
          invocation as {
            eventEmitter: AgentEventEmitter;
          }
        ).eventEmitter;

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

      // ---- L3: Tool's default permission ----
      // In YOLO mode, force 'allow' for everything except ask_user_question.
      const defaultPermission =
        this.config.getApprovalMode() !== ApprovalMode.YOLO ||
        isAskUserQuestionTool
          ? await invocation.getDefaultPermission()
          : 'allow';

      // ---- L4: PermissionManager override (if relevant rules exist) ----
      const toolParams = invocation.params as Record<string, unknown>;
      const pmCtx = buildPermissionCheckContext(
        fc.name,
        toolParams,
        this.config.getTargetDir?.() ?? '',
      );
      const { finalPermission, pmForcedAsk } = await evaluatePermissionRules(
        pm,
        defaultPermission,
        pmCtx,
      );

      const needsConfirmation = finalPermission === 'ask';

      // ---- L5: ApprovalMode overrides ----
      const approvalMode = this.config.getApprovalMode();
      const isPlanMode = approvalMode === ApprovalMode.PLAN;

      if (finalPermission === 'deny') {
        return earlyErrorResponse(
          new Error(
            defaultPermission === 'deny'
              ? `Tool "${fc.name}" is denied: command substitution is not allowed for security reasons.`
              : `Tool "${fc.name}" is denied by permission rules.`,
          ),
          fc.name,
        );
      }

      let didRequestPermission = false;
      let confirmationDetails: ToolCallConfirmationDetails | undefined;

      if (needsConfirmation) {
        confirmationDetails =
          await invocation.getConfirmationDetails(abortSignal);

        // Centralised rule injection (for display and persistence)
        injectPermissionRulesIfMissing(confirmationDetails, pmCtx);

        if (
          isPlanMode &&
          !isExitPlanModeTool &&
          !isAskUserQuestionTool &&
          confirmationDetails.type !== 'info'
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
        const hooksEnabled = this.config.getEnableHooks?.() ?? false;
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

              await this.resolveIdeDiffForOutcome(
                confirmationDetails,
                ToolConfirmationOutcome.ProceedOnce,
              );
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
              `proto needs your permission to use ${fc.name}`,
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

          await this.resolveIdeDiffForOutcome(confirmationDetails, outcome);

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

      const toolResult: ToolResult = await invocation.execute(abortSignal);

      // Clean up event listeners
      subAgentCleanupFunctions.forEach((cleanup) => cleanup());

      // Create response parts first (needed for emitResult and recordToolResult)
      const responseParts = convertToFunctionResponse(
        fc.name,
        callId,
        toolResult.llmContent,
      );

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
        await this.client.extNotification('_qwencode/slash_command', {
          sessionId: this.sessionId,
          command: originalPrompt
            .filter((block) => block.type === 'text')
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join(' '),
          messageType: result.messageType,
          message: result.content || '',
        });

        if (result.messageType === 'error') {
          // Throw error to stop execution
          throw new Error(result.content || 'Slash command failed.');
        }
        // For info messages, return null to indicate command was handled
        return null;
      }

      case 'stream_messages': {
        // Command returns multiple messages via async generator (ACP-preferred)
        const command = originalPrompt
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join(' ');

        // Stream all messages to the client
        for await (const msg of result.messages) {
          await this.client.extNotification('_qwencode/slash_command', {
            sessionId: this.sessionId,
            command,
            messageType: msg.messageType,
            message: msg.content,
          });

          // If we encounter an error message, throw after sending
          if (msg.messageType === 'error') {
            throw new Error(msg.content || 'Slash command failed.');
          }
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
