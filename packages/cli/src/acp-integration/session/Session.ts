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
  SubAgentEventEmitter,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  convertToFunctionResponse,
  DiscoveredMCPTool,
  StreamEventType,
  ToolConfirmationOutcome,
  logToolCall,
  logUserPrompt,
  getErrorStatus,
  isWithinRoot,
  isNodeError,
  TaskTool,
  UserPromptEvent,
  TodoWriteTool,
  ExitPlanModeTool,
} from '@qwen-code/qwen-code-core';

import * as acp from '../acp.js';
import type { LoadedSettings } from '../../config/settings.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { getErrorMessage } from '../../utils/errors.js';
import {
  handleSlashCommand,
  getAvailableCommands,
} from '../../nonInteractiveCliCommands.js';
import type {
  AvailableCommand,
  AvailableCommandsUpdate,
  SetModeRequest,
  SetModeResponse,
  ApprovalModeValue,
  CurrentModeUpdate,
} from '../schema.js';
import { isSlashCommand } from '../../ui/utils/commandUtils.js';

// Import modular session components
import type { SessionContext, ToolCallStartParams } from './types.js';
import { HistoryReplayer } from './HistoryReplayer.js';
import { ToolCallEmitter } from './emitters/ToolCallEmitter.js';
import { PlanEmitter } from './emitters/PlanEmitter.js';
import { MessageEmitter } from './emitters/MessageEmitter.js';
import { SubAgentTracker } from './SubAgentTracker.js';

/**
 * Built-in commands that are allowed in ACP integration mode.
 * Only safe, read-only commands that don't require interactive UI.
 */
export const ALLOWED_BUILTIN_COMMANDS_FOR_ACP = ['init'];

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
  private turn: number = 0;

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
    private readonly client: acp.Client,
    private readonly settings: LoadedSettings,
  ) {
    this.sessionId = id;

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
    if (!this.pendingPrompt) {
      throw new Error('Not currently generating');
    }

    this.pendingPrompt.abort();
    this.pendingPrompt = null;
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.pendingPrompt?.abort();
    const pendingSend = new AbortController();
    this.pendingPrompt = pendingSend;

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
    const firstTextBlock = params.prompt.find((block) => block.type === 'text');
    const inputText = firstTextBlock?.text || '';

    let parts: Part[];

    if (isSlashCommand(inputText)) {
      // Handle slash command - allow specific built-in commands for ACP integration
      const slashCommandResult = await handleSlashCommand(
        inputText,
        pendingSend,
        this.config,
        this.settings,
        ALLOWED_BUILTIN_COMMANDS_FOR_ACP,
      );

      if (slashCommandResult) {
        // Use the result from the slash command
        parts = slashCommandResult as Part[];
      } else {
        // Slash command didn't return a prompt, continue with normal processing
        parts = await this.#resolvePrompt(params.prompt, pendingSend.signal);
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

          if (resp.type === StreamEventType.CHUNK && resp.value.usageMetadata) {
            usageMetadata = resp.value.usageMetadata;
          }

          if (resp.type === StreamEventType.CHUNK && resp.value.functionCalls) {
            functionCalls.push(...resp.value.functionCalls);
          }
        }
      } catch (error) {
        if (getErrorStatus(error) === 429) {
          throw new acp.RequestError(
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
          const response = await this.runTool(pendingSend.signal, promptId, fc);
          toolResponseParts.push(...response);
        }

        nextMessage = { role: 'user', parts: toolResponseParts };
      }
    }

    return { stopReason: 'end_turn' };
  }

  async sendUpdate(update: acp.SessionUpdate): Promise<void> {
    const params: acp.SessionNotification = {
      sessionId: this.sessionId,
      update,
    };

    await this.client.sessionUpdate(params);
  }

  async sendAvailableCommandsUpdate(): Promise<void> {
    const abortController = new AbortController();
    try {
      const slashCommands = await getAvailableCommands(
        this.config,
        this.settings,
        abortController.signal,
        ALLOWED_BUILTIN_COMMANDS_FOR_ACP,
      );

      // Convert SlashCommand[] to AvailableCommand[] format for ACP protocol
      const availableCommands: AvailableCommand[] = slashCommands.map(
        (cmd) => ({
          name: cmd.name,
          description: cmd.description,
          input: null,
        }),
      );

      const update: AvailableCommandsUpdate = {
        sessionUpdate: 'available_commands_update',
        availableCommands,
      };

      await this.sendUpdate(update);
    } catch (error) {
      // Log error but don't fail session creation
      console.error('Error sending available commands update:', error);
    }
  }

  /**
   * Requests permission from the client for a tool call.
   * Used by SubAgentTracker for sub-agent approval requests.
   */
  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return this.client.requestPermission(params);
  }

  /**
   * Sets the approval mode for the current session.
   * Maps ACP approval mode values to core ApprovalMode enum.
   */
  async setMode(params: SetModeRequest): Promise<SetModeResponse> {
    const modeMap: Record<ApprovalModeValue, ApprovalMode> = {
      plan: ApprovalMode.PLAN,
      default: ApprovalMode.DEFAULT,
      'auto-edit': ApprovalMode.AUTO_EDIT,
      yolo: ApprovalMode.YOLO,
    };

    const approvalMode = modeMap[params.modeId];
    this.config.setApprovalMode(approvalMode);

    return { modeId: params.modeId };
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

    const update: CurrentModeUpdate = {
      sessionUpdate: 'current_mode_update',
      modeId: newModeId,
    };

    await this.sendUpdate(update);
  }

  private async runTool(
    abortSignal: AbortSignal,
    promptId: string,
    fc: FunctionCall,
  ): Promise<Part[]> {
    const callId = fc.id ?? `${fc.name}-${Date.now()}`;
    const args = (fc.args ?? {}) as Record<string, unknown>;

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

    if (!fc.name) {
      return errorResponse(new Error('Missing function name'));
    }

    const toolRegistry = this.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name as string);

    if (!tool) {
      return errorResponse(
        new Error(`Tool "${fc.name}" not found in registry.`),
      );
    }

    // Detect TodoWriteTool early - route to plan updates instead of tool_call events
    const isTodoWriteTool = tool.name === TodoWriteTool.Name;
    const isTaskTool = tool.name === TaskTool.Name;
    const isExitPlanModeTool = tool.name === ExitPlanModeTool.Name;

    // Track cleanup functions for sub-agent event listeners
    let subAgentCleanupFunctions: Array<() => void> = [];

    try {
      const invocation = tool.build(args);

      if (isTaskTool && 'eventEmitter' in invocation) {
        // Access eventEmitter from TaskTool invocation
        const taskEventEmitter = (
          invocation as {
            eventEmitter: SubAgentEventEmitter;
          }
        ).eventEmitter;

        // Create a SubAgentTracker for this tool execution
        const subAgentTracker = new SubAgentTracker(this, this.client);

        // Set up sub-agent tool tracking
        subAgentCleanupFunctions = subAgentTracker.setup(
          taskEventEmitter,
          abortSignal,
        );
      }

      const confirmationDetails =
        this.config.getApprovalMode() !== ApprovalMode.YOLO
          ? await invocation.shouldConfirmExecute(abortSignal)
          : false;

      if (confirmationDetails) {
        const content: acp.ToolCallContent[] = [];

        if (confirmationDetails.type === 'edit') {
          content.push({
            type: 'diff',
            path: confirmationDetails.fileName,
            oldText: confirmationDetails.originalContent,
            newText: confirmationDetails.newContent,
          });
        }

        // Add plan content for exit_plan_mode
        if (confirmationDetails.type === 'plan') {
          content.push({
            type: 'content',
            content: {
              type: 'text',
              text: confirmationDetails.plan,
            },
          });
        }

        // Map tool kind, using switch_mode for exit_plan_mode per ACP spec
        const mappedKind = this.toolCallEmitter.mapToolKind(tool.kind, fc.name);

        const params: acp.RequestPermissionRequest = {
          sessionId: this.sessionId,
          options: toPermissionOptions(confirmationDetails),
          toolCall: {
            toolCallId: callId,
            status: 'pending',
            title: invocation.getDescription(),
            content,
            locations: invocation.toolLocations(),
            kind: mappedKind,
          },
        };

        const output = await this.client.requestPermission(params);
        const outcome =
          output.outcome.outcome === 'cancelled'
            ? ToolConfirmationOutcome.Cancel
            : z
                .nativeEnum(ToolConfirmationOutcome)
                .parse(output.outcome.optionId);

        await confirmationDetails.onConfirm(outcome);

        // After exit_plan_mode confirmation, send current_mode_update notification
        if (isExitPlanModeTool && outcome !== ToolConfirmationOutcome.Cancel) {
          await this.sendCurrentModeUpdateNotification(outcome);
        }

        switch (outcome) {
          case ToolConfirmationOutcome.Cancel:
            return errorResponse(
              new Error(`Tool "${fc.name}" was canceled by the user.`),
            );
          case ToolConfirmationOutcome.ProceedOnce:
          case ToolConfirmationOutcome.ProceedAlways:
          case ToolConfirmationOutcome.ProceedAlwaysServer:
          case ToolConfirmationOutcome.ProceedAlwaysTool:
          case ToolConfirmationOutcome.ModifyWithEditor:
            break;
          default: {
            const resultOutcome: never = outcome;
            throw new Error(`Unexpected: ${resultOutcome}`);
          }
        }
      } else if (!isTodoWriteTool) {
        // Skip tool_call event for TodoWriteTool - use ToolCallEmitter
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
      await this.toolCallEmitter.emitError(callId, error);

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

  async #resolvePrompt(
    message: acp.ContentBlock[],
    abortSignal: AbortSignal,
  ): Promise<Part[]> {
    const FILE_URI_SCHEME = 'file://';

    const embeddedContext: acp.EmbeddedResourceResource[] = [];

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

    const atPathToResolvedSpecMap = new Map<string, string>();

    // Get centralized file discovery service
    const fileDiscovery = this.config.getFileService();
    const respectGitIgnore = this.config.getFileFilteringRespectGitIgnore();

    const pathSpecsToRead: string[] = [];
    const contentLabelsForDisplay: string[] = [];
    const ignoredPaths: string[] = [];

    const toolRegistry = this.config.getToolRegistry();
    const readManyFilesTool = toolRegistry.getTool('read_many_files');
    const globTool = toolRegistry.getTool('glob');

    if (!readManyFilesTool) {
      throw new Error('Error: read_many_files tool not found.');
    }

    for (const atPathPart of atPathCommandParts) {
      const pathName = atPathPart.fileData!.fileUri;
      // Check if path should be ignored by git
      if (fileDiscovery.shouldGitIgnoreFile(pathName)) {
        ignoredPaths.push(pathName);
        const reason = respectGitIgnore
          ? 'git-ignored and will be skipped'
          : 'ignored by custom patterns';
        console.warn(`Path ${pathName} is ${reason}.`);
        continue;
      }
      let currentPathSpec = pathName;
      let resolvedSuccessfully = false;
      try {
        const absolutePath = path.resolve(this.config.getTargetDir(), pathName);
        if (isWithinRoot(absolutePath, this.config.getTargetDir())) {
          const stats = await fs.stat(absolutePath);
          if (stats.isDirectory()) {
            currentPathSpec = pathName.endsWith('/')
              ? `${pathName}**`
              : `${pathName}/**`;
            this.debug(
              `Path ${pathName} resolved to directory, using glob: ${currentPathSpec}`,
            );
          } else {
            this.debug(`Path ${pathName} resolved to file: ${currentPathSpec}`);
          }
          resolvedSuccessfully = true;
        } else {
          this.debug(
            `Path ${pathName} is outside the project directory. Skipping.`,
          );
        }
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (this.config.getEnableRecursiveFileSearch() && globTool) {
            this.debug(
              `Path ${pathName} not found directly, attempting glob search.`,
            );
            try {
              const globResult = await globTool.buildAndExecute(
                {
                  pattern: `**/*${pathName}*`,
                  path: this.config.getTargetDir(),
                },
                abortSignal,
              );
              if (
                globResult.llmContent &&
                typeof globResult.llmContent === 'string' &&
                !globResult.llmContent.startsWith('No files found') &&
                !globResult.llmContent.startsWith('Error:')
              ) {
                const lines = globResult.llmContent.split('\n');
                if (lines.length > 1 && lines[1]) {
                  const firstMatchAbsolute = lines[1].trim();
                  currentPathSpec = path.relative(
                    this.config.getTargetDir(),
                    firstMatchAbsolute,
                  );
                  this.debug(
                    `Glob search for ${pathName} found ${firstMatchAbsolute}, using relative path: ${currentPathSpec}`,
                  );
                  resolvedSuccessfully = true;
                } else {
                  this.debug(
                    `Glob search for '**/*${pathName}*' did not return a usable path. Path ${pathName} will be skipped.`,
                  );
                }
              } else {
                this.debug(
                  `Glob search for '**/*${pathName}*' found no files or an error. Path ${pathName} will be skipped.`,
                );
              }
            } catch (globError) {
              console.error(
                `Error during glob search for ${pathName}: ${getErrorMessage(globError)}`,
              );
            }
          } else {
            this.debug(
              `Glob tool not found. Path ${pathName} will be skipped.`,
            );
          }
        } else {
          console.error(
            `Error stating path ${pathName}. Path ${pathName} will be skipped.`,
          );
        }
      }
      if (resolvedSuccessfully) {
        pathSpecsToRead.push(currentPathSpec);
        atPathToResolvedSpecMap.set(pathName, currentPathSpec);
        contentLabelsForDisplay.push(pathName);
      }
    }

    // Construct the initial part of the query for the LLM
    let initialQueryText = '';
    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      if ('text' in chunk) {
        initialQueryText += chunk.text;
      } else {
        // type === 'atPath'
        const resolvedSpec =
          chunk.fileData && atPathToResolvedSpecMap.get(chunk.fileData.fileUri);
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ') &&
          resolvedSpec
        ) {
          // Add space if previous part was text and didn't end with space, or if previous was @path
          const prevPart = parts[i - 1];
          if (
            'text' in prevPart ||
            ('fileData' in prevPart &&
              atPathToResolvedSpecMap.has(prevPart.fileData!.fileUri))
          ) {
            initialQueryText += ' ';
          }
        }
        // Append the resolved path spec for display purposes
        if (resolvedSpec) {
          initialQueryText += `@${resolvedSpec}`;
        }
      }
    }

    // Handle ignored paths message
    let ignoredPathsMessage = '';
    if (ignoredPaths.length > 0) {
      const pathList = ignoredPaths.map((p) => `- ${p}`).join('\n');
      ignoredPathsMessage = `Note: The following paths were skipped because they are ignored:\n${pathList}\n\n`;
    }

    const processedQueryParts: Part[] = [];

    // Read files using read_many_files tool
    if (pathSpecsToRead.length > 0) {
      const readResult = await readManyFilesTool.buildAndExecute(
        {
          paths_with_line_ranges: pathSpecsToRead,
        },
        abortSignal,
      );

      const contentForLlm =
        typeof readResult.llmContent === 'string'
          ? readResult.llmContent
          : JSON.stringify(readResult.llmContent);

      // Combine content label, ignored paths message, file content, and user query
      const combinedText = `${ignoredPathsMessage}${contentForLlm}`.trim();
      processedQueryParts.push({ text: combinedText });
      processedQueryParts.push({ text: initialQueryText });
    } else if (embeddedContext.length > 0) {
      // No @path files to read, but we have embedded context
      processedQueryParts.push({
        text: `${ignoredPathsMessage}${initialQueryText}`.trim(),
      });
    } else {
      // No @path files found or resolved
      processedQueryParts.push({
        text: `${ignoredPathsMessage}${initialQueryText}`.trim(),
      });
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
      console.warn(msg);
    }
  }
}

// ============================================================================
// Helper functions
// ============================================================================

const basicPermissionOptions = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
] as const;

function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
): acp.PermissionOption[] {
  switch (confirmation.type) {
    case 'edit':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow All Edits',
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'exec':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: `Always Allow ${confirmation.rootCommand}`,
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'mcp':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlwaysServer,
          name: `Always Allow ${confirmation.serverName}`,
          kind: 'allow_always',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedAlwaysTool,
          name: `Always Allow ${confirmation.toolName}`,
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'info':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: `Always Allow`,
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'plan':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: `Yes, and auto-accept edits`,
          kind: 'allow_always',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          name: `Yes, and manually approve edits`,
          kind: 'allow_once',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          name: `No, keep planning (esc)`,
          kind: 'reject_once',
        },
      ];
    default: {
      const unreachable: never = confirmation;
      throw new Error(`Unexpected: ${unreachable}`);
    }
  }
}
