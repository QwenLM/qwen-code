/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ToolResultDisplay,
  TaskResultDisplay,
  OutputUpdateHandler,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  SessionMetrics,
} from '@qwen-code/qwen-code-core';
import {
  OutputFormat,
  ToolErrorType,
  getMCPServerStatus,
} from '@qwen-code/qwen-code-core';
import type { Part, PartListUnion } from '@google/genai';
import type {
  CLIUserMessage,
  Usage,
  PermissionMode,
  CLISystemMessage,
} from '../nonInteractive/types.js';
import { CommandService } from '../services/CommandService.js';
import { BuiltinCommandLoader } from '../services/BuiltinCommandLoader.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import { computeSessionStats } from '../ui/utils/computeStats.js';

/**
 * Normalizes various part list formats into a consistent Part[] array.
 *
 * @param parts - Input parts in various formats (string, Part, Part[], or null)
 * @returns Normalized array of Part objects
 */
export function normalizePartList(parts: PartListUnion | null): Part[] {
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

/**
 * Extracts user message parts from a CLI protocol message.
 *
 * @param message - User message sourced from the CLI protocol layer
 * @returns Extracted parts or null if the message lacks textual content
 */
export function extractPartsFromUserMessage(
  message: CLIUserMessage | undefined,
): PartListUnion | null {
  if (!message) {
    return null;
  }

  const content = message.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: Part[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        continue;
      }
      if (block.type === 'text' && 'text' in block && block.text) {
        parts.push({ text: block.text });
      } else {
        parts.push({ text: JSON.stringify(block) });
      }
    }
    return parts.length > 0 ? parts : null;
  }

  return null;
}

/**
 * Extracts usage metadata from the Gemini client's debug responses.
 *
 * @param geminiClient - The Gemini client instance
 * @returns Usage information or undefined if not available
 */
export function extractUsageFromGeminiClient(
  geminiClient: unknown,
): Usage | undefined {
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
          input_tokens: typeof promptTokens === 'number' ? promptTokens : 0,
          output_tokens:
            typeof completionTokens === 'number' ? completionTokens : 0,
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

/**
 * Computes Usage information from SessionMetrics using computeSessionStats.
 * Aggregates token usage across all models in the session.
 *
 * @param metrics - Session metrics from uiTelemetryService
 * @returns Usage object with token counts
 */
export function computeUsageFromMetrics(metrics: SessionMetrics): Usage {
  const stats = computeSessionStats(metrics);
  const { models } = metrics;

  // Sum up output tokens (candidates) and total tokens across all models
  const totalOutputTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.candidates,
    0,
  );
  const totalTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.total,
    0,
  );

  const usage: Usage = {
    input_tokens: stats.totalPromptTokens,
    output_tokens: totalOutputTokens,
    cache_read_input_tokens: stats.totalCachedTokens,
  };

  // Only include total_tokens if it's greater than 0
  if (totalTokens > 0) {
    usage.total_tokens = totalTokens;
  }

  return usage;
}

/**
 * Load slash command names using CommandService
 *
 * @param config - Config instance
 * @returns Promise resolving to array of slash command names
 */
async function loadSlashCommandNames(config: Config): Promise<string[]> {
  const controller = new AbortController();
  try {
    const service = await CommandService.create(
      [new BuiltinCommandLoader(config)],
      controller.signal,
    );
    const names = new Set<string>();
    const commands = service.getCommands();
    for (const command of commands) {
      names.add(command.name);
    }
    return Array.from(names).sort();
  } catch (error) {
    if (config.getDebugMode()) {
      console.error(
        '[buildSystemMessage] Failed to load slash commands:',
        error,
      );
    }
    return [];
  } finally {
    controller.abort();
  }
}

/**
 * Build system message for SDK
 *
 * Constructs a system initialization message including tools, MCP servers,
 * and model configuration. System messages are independent of the control
 * system and are sent before every turn regardless of whether control
 * system is available.
 *
 * Note: Control capabilities are NOT included in system messages. They
 * are only included in the initialize control response, which is handled
 * separately by SystemController.
 *
 * @param config - Config instance
 * @param sessionId - Session identifier
 * @param permissionMode - Current permission/approval mode
 * @returns Promise resolving to CLISystemMessage
 */
export async function buildSystemMessage(
  config: Config,
  sessionId: string,
  permissionMode: PermissionMode,
): Promise<CLISystemMessage> {
  const toolRegistry = config.getToolRegistry();
  const tools = toolRegistry ? toolRegistry.getAllToolNames() : [];

  const mcpServers = config.getMcpServers();
  const mcpServerList = mcpServers
    ? Object.keys(mcpServers).map((name) => ({
        name,
        status: getMCPServerStatus(name),
      }))
    : [];

  // Load slash commands
  const slashCommands = await loadSlashCommandNames(config);

  // Load subagent names from config
  let agentNames: string[] = [];
  try {
    const subagentManager = config.getSubagentManager();
    const subagents = await subagentManager.listSubagents();
    agentNames = subagents.map((subagent) => subagent.name);
  } catch (error) {
    if (config.getDebugMode()) {
      console.error('[buildSystemMessage] Failed to load subagents:', error);
    }
  }

  const systemMessage: CLISystemMessage = {
    type: 'system',
    subtype: 'init',
    uuid: sessionId,
    session_id: sessionId,
    cwd: config.getTargetDir(),
    tools,
    mcp_servers: mcpServerList,
    model: config.getModel(),
    permissionMode,
    slash_commands: slashCommands,
    qwen_code_version: config.getCliVersion() || 'unknown',
    agents: agentNames,
  };

  return systemMessage;
}

/**
 * Creates an output update handler specifically for Task tool subagent execution.
 * This handler monitors TaskResultDisplay updates and converts them to protocol messages
 * using the unified adapter's subagent APIs. All emitted messages will have parent_tool_use_id set to
 * the task tool's callId.
 *
 * @param config - Config instance for getting output format
 * @param taskToolCallId - The task tool's callId to use as parent_tool_use_id for all subagent messages
 * @param adapter - The unified adapter instance (JsonOutputAdapter or StreamJsonOutputAdapter)
 * @returns An object containing the output update handler
 */
export function createTaskToolProgressHandler(
  config: Config,
  taskToolCallId: string,
  adapter: JsonOutputAdapterInterface | undefined,
): {
  handler: OutputUpdateHandler;
} {
  // Track previous TaskResultDisplay states per tool call to detect changes
  const previousTaskStates = new Map<string, TaskResultDisplay>();
  // Track which tool call IDs have already emitted tool_use to prevent duplicates
  const emittedToolUseIds = new Set<string>();
  // Track which tool call IDs have already emitted tool_result to prevent duplicates
  const emittedToolResultIds = new Set<string>();

  /**
   * Builds a ToolCallRequestInfo object from a tool call.
   *
   * @param toolCall - The tool call information
   * @returns ToolCallRequestInfo object
   */
  const buildRequest = (
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
  ): ToolCallRequestInfo => ({
    callId: toolCall.callId,
    name: toolCall.name,
    args: toolCall.args || {},
    isClientInitiated: true,
    prompt_id: '',
    response_id: undefined,
  });

  /**
   * Builds a ToolCallResponseInfo object from a tool call.
   *
   * @param toolCall - The tool call information
   * @returns ToolCallResponseInfo object
   */
  const buildResponse = (
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
  ): ToolCallResponseInfo => ({
    callId: toolCall.callId,
    error:
      toolCall.status === 'failed'
        ? new Error(toolCall.error || 'Tool execution failed')
        : undefined,
    errorType:
      toolCall.status === 'failed' ? ToolErrorType.EXECUTION_FAILED : undefined,
    resultDisplay: toolCall.resultDisplay,
    responseParts: toolCall.responseParts || [],
  });

  /**
   * Checks if a tool call has result content that should be emitted.
   *
   * @param toolCall - The tool call information
   * @returns True if the tool call has result content to emit
   */
  const hasResultContent = (
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
  ): boolean => {
    // Check resultDisplay string
    if (
      typeof toolCall.resultDisplay === 'string' &&
      toolCall.resultDisplay.trim().length > 0
    ) {
      return true;
    }

    // Check responseParts - only check existence, don't parse for performance
    if (toolCall.responseParts && toolCall.responseParts.length > 0) {
      return true;
    }

    // Failed status should always emit result
    return toolCall.status === 'failed';
  };

  /**
   * Emits tool_use for a tool call if it hasn't been emitted yet.
   *
   * @param toolCall - The tool call information
   * @param fallbackStatus - Optional fallback status if toolCall.status should be overridden
   */
  const emitToolUseIfNeeded = (
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
    fallbackStatus?: 'executing' | 'awaiting_approval',
  ): void => {
    if (emittedToolUseIds.has(toolCall.callId)) {
      return;
    }

    const toolCallToEmit: NonNullable<TaskResultDisplay['toolCalls']>[number] =
      fallbackStatus
        ? {
            ...toolCall,
            status: fallbackStatus,
          }
        : toolCall;

    if (
      toolCallToEmit.status === 'executing' ||
      toolCallToEmit.status === 'awaiting_approval'
    ) {
      if (adapter?.processSubagentToolCall) {
        adapter.processSubagentToolCall(toolCallToEmit, taskToolCallId);
        emittedToolUseIds.add(toolCall.callId);
      }
    }
  };

  /**
   * Emits tool_result for a tool call if it hasn't been emitted yet and has content.
   *
   * @param toolCall - The tool call information
   */
  const emitToolResultIfNeeded = (
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
  ): void => {
    if (emittedToolResultIds.has(toolCall.callId)) {
      return;
    }

    if (!hasResultContent(toolCall)) {
      return;
    }

    // Mark as emitted even if we skip, to prevent duplicate emits
    emittedToolResultIds.add(toolCall.callId);

    if (adapter) {
      const request = buildRequest(toolCall);
      const response = buildResponse(toolCall);
      // For subagent tool results, we need to pass parentToolUseId
      // The adapter implementations accept an optional parentToolUseId parameter
      if (
        'emitToolResult' in adapter &&
        typeof adapter.emitToolResult === 'function'
      ) {
        adapter.emitToolResult(request, response, taskToolCallId);
      } else {
        adapter.emitToolResult(request, response);
      }
    }
  };

  /**
   * Processes a tool call, ensuring tool_use and tool_result are emitted exactly once.
   *
   * @param toolCall - The tool call information
   * @param previousCall - The previous state of the tool call (if any)
   */
  const processToolCall = (
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
    previousCall?: NonNullable<TaskResultDisplay['toolCalls']>[number],
  ): void => {
    const isCompleted =
      toolCall.status === 'success' || toolCall.status === 'failed';
    const isExecuting =
      toolCall.status === 'executing' ||
      toolCall.status === 'awaiting_approval';
    const wasExecuting =
      previousCall &&
      (previousCall.status === 'executing' ||
        previousCall.status === 'awaiting_approval');

    // Emit tool_use if needed
    if (isExecuting) {
      // Normal case: tool call is executing or awaiting approval
      emitToolUseIfNeeded(toolCall);
    } else if (isCompleted && !emittedToolUseIds.has(toolCall.callId)) {
      // Edge case: tool call appeared with result already (shouldn't happen normally,
      // but handle it gracefully by emitting tool_use with 'executing' status first)
      emitToolUseIfNeeded(toolCall, 'executing');
    } else if (wasExecuting && isCompleted) {
      // Status changed from executing to completed - ensure tool_use was emitted
      emitToolUseIfNeeded(toolCall, 'executing');
    }

    // Emit tool_result if tool call is completed
    if (isCompleted) {
      emitToolResultIfNeeded(toolCall);
    }
  };

  const outputUpdateHandler = (
    callId: string,
    outputChunk: ToolResultDisplay,
  ) => {
    // Only process TaskResultDisplay (Task tool updates)
    if (
      typeof outputChunk === 'object' &&
      outputChunk !== null &&
      'type' in outputChunk &&
      outputChunk.type === 'task_execution'
    ) {
      const taskDisplay = outputChunk as TaskResultDisplay;
      const previous = previousTaskStates.get(callId);

      // If no adapter, just track state (for non-JSON modes)
      if (!adapter) {
        previousTaskStates.set(callId, taskDisplay);
        return;
      }

      // Only process if adapter supports subagent APIs
      if (
        !adapter.processSubagentToolCall ||
        !adapter.emitSubagentErrorResult
      ) {
        previousTaskStates.set(callId, taskDisplay);
        return;
      }

      if (taskDisplay.toolCalls) {
        if (!previous || !previous.toolCalls) {
          // First time seeing tool calls - process all initial ones
          for (const toolCall of taskDisplay.toolCalls) {
            processToolCall(toolCall);
          }
        } else {
          // Compare with previous state to find new/changed tool calls
          for (const toolCall of taskDisplay.toolCalls) {
            const previousCall = previous.toolCalls.find(
              (tc) => tc.callId === toolCall.callId,
            );
            processToolCall(toolCall, previousCall);
          }
        }
      }

      // Handle task-level errors (status: 'failed', 'cancelled')
      if (
        taskDisplay.status === 'failed' ||
        taskDisplay.status === 'cancelled'
      ) {
        const previousStatus = previous?.status;
        // Only emit error result if status changed to failed/cancelled
        if (
          previousStatus !== 'failed' &&
          previousStatus !== 'cancelled' &&
          previousStatus !== undefined
        ) {
          const errorMessage =
            taskDisplay.terminateReason ||
            (taskDisplay.status === 'cancelled'
              ? 'Task was cancelled'
              : 'Task execution failed');
          // Use subagent adapter's emitSubagentErrorResult method
          adapter.emitSubagentErrorResult(errorMessage, 0, taskToolCallId);
        }
      }

      // Handle subagent initial message (prompt) in non-interactive mode with json/stream-json output
      // Emit when this is the first update (previous is undefined) and task starts
      if (
        !previous &&
        taskDisplay.taskPrompt &&
        !config.isInteractive() &&
        (config.getOutputFormat() === OutputFormat.JSON ||
          config.getOutputFormat() === OutputFormat.STREAM_JSON)
      ) {
        // Emit the user message with the correct parent_tool_use_id
        adapter.emitUserMessage(
          [{ text: taskDisplay.taskPrompt }],
          taskToolCallId,
        );
      }

      // Update previous state
      previousTaskStates.set(callId, taskDisplay);
    }
  };

  // No longer need to attach adapter to handler - task.ts uses TaskResultDisplay.message instead

  return {
    handler: outputUpdateHandler,
  };
}

/**
 * Converts function response parts to a string representation.
 * Handles functionResponse parts specially by extracting their output content.
 *
 * @param parts - Array of Part objects to convert
 * @returns String representation of the parts
 */
export function functionResponsePartsToString(parts: Part[]): string {
  return parts
    .map((part) => {
      if ('functionResponse' in part) {
        const content = part.functionResponse?.response?.['output'] ?? '';
        return content;
      }
      return JSON.stringify(part);
    })
    .join('');
}

/**
 * Extracts content from a tool call response for inclusion in tool_result blocks.
 * Uses functionResponsePartsToString to properly handle functionResponse parts,
 * which correctly extracts output content from functionResponse objects rather
 * than simply concatenating text or JSON.stringify.
 *
 * @param response - Tool call response information
 * @returns String content for the tool_result block, or undefined if no content available
 */
export function toolResultContent(
  response: ToolCallResponseInfo,
): string | undefined {
  if (
    typeof response.resultDisplay === 'string' &&
    response.resultDisplay.trim().length > 0
  ) {
    return response.resultDisplay;
  }
  if (response.responseParts && response.responseParts.length > 0) {
    // Always use functionResponsePartsToString to properly handle
    // functionResponse parts that contain output content
    return functionResponsePartsToString(response.responseParts);
  }
  if (response.error) {
    return response.error.message;
  }
  return undefined;
}
