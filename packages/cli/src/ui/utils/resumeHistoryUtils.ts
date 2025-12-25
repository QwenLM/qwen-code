/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, FunctionCall } from '@google/genai';
import type {
  ResumedSessionData,
  ConversationRecord,
  Config,
  AnyDeclarativeTool,
  ToolResultDisplay,
  SlashCommandRecordPayload,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import { ToolCallStatus } from '../types.js';

/**
 * Extracts text content from a Content object's parts (excluding thought parts).
 */
function extractTextFromParts(parts: Part[] | undefined): string {
  if (!parts) return '';

  const textParts: string[] = [];
  for (const part of parts) {
    if ('text' in part && part.text) {
      // Skip thought parts - they have a 'thought' property
      if (!('thought' in part && part.thought)) {
        textParts.push(part.text);
      }
    }
  }
  return textParts.join('\n');
}

/**
 * Extracts thought text content from a Content object's parts.
 * Thought parts are identified by having `thought: true`.
 */
function extractThoughtTextFromParts(parts: Part[] | undefined): string {
  if (!parts) return '';

  const thoughtParts: string[] = [];
  for (const part of parts) {
    if ('text' in part && part.text && 'thought' in part && part.thought) {
      thoughtParts.push(part.text);
    }
  }
  return thoughtParts.join('\n');
}

/**
 * Extracts function calls from a Content object's parts.
 */
function extractFunctionCalls(
  parts: Part[] | undefined,
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  if (!parts) return [];

  const calls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }> = [];
  for (const part of parts) {
    if ('functionCall' in part && part.functionCall) {
      const fc = part.functionCall as FunctionCall;
      calls.push({
        id: fc.id || `call-${calls.length}`,
        name: fc.name || 'unknown',
        args: (fc.args as Record<string, unknown>) || {},
      });
    }
  }
  return calls;
}

function getTool(config: Config, name: string): AnyDeclarativeTool | undefined {
  const toolRegistry = config.getToolRegistry();
  return toolRegistry.getTool(name);
}

/**
 * Formats a tool description from its name and arguments using actual tool instances.
 * This ensures we get the exact same descriptions as during normal operation.
 */
function formatToolDescription(
  tool: AnyDeclarativeTool,
  args: Record<string, unknown>,
): string {
  try {
    // Create tool invocation instance and get description
    const invocation = tool.build(args);
    return invocation.getDescription();
  } catch {
    return '';
  }
}

/**
 * Restores a HistoryItemWithoutId from the serialized shape stored in
 * SlashCommandRecordPayload.outputHistoryItems.
 */
function restoreHistoryItem(raw: unknown): HistoryItemWithoutId | undefined {
  if (!raw || typeof raw !== 'object') {
    return;
  }

  const clone = { ...(raw as Record<string, unknown>) };
  if ('timestamp' in clone) {
    const ts = clone['timestamp'];
    if (typeof ts === 'string' || typeof ts === 'number') {
      clone['timestamp'] = new Date(ts);
    }
  }

  if (typeof clone['type'] !== 'string') {
    return;
  }

  return clone as unknown as HistoryItemWithoutId;
}

/**
 * Converts ChatRecord messages to UI history items for display.
 *
 * This function transforms the raw ChatRecords into a format suitable
 * for the CLI's HistoryItemDisplay component.
 *
 * @param conversation The conversation record from a resumed session
 * @param config The config object for accessing tool registry
 * @returns Array of history items for UI display
 */
function convertToHistoryItems(
  conversation: ConversationRecord,
  config: Config,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];

  // Track pending tool calls for grouping with results
  const pendingToolCalls = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  let currentToolGroup: Array<{
    callId: string;
    name: string;
    description: string;
    resultDisplay: ToolResultDisplay | undefined;
    status: ToolCallStatus;
    confirmationDetails: undefined;
  }> = [];

  for (const record of conversation.messages) {
    if (record.type === 'system') {
      if (record.subtype === 'slash_command') {
        // Flush any pending tool group to avoid mixing contexts.
        if (currentToolGroup.length > 0) {
          items.push({
            type: 'tool_group',
            tools: [...currentToolGroup],
          });
          currentToolGroup = [];
        }
        const payload = record.systemPayload as
          | SlashCommandRecordPayload
          | undefined;
        if (!payload) continue;
        if (payload.phase === 'invocation' && payload.rawCommand) {
          items.push({ type: 'user', text: payload.rawCommand });
        }
        if (payload.phase === 'result') {
          const outputs = payload.outputHistoryItems ?? [];
          for (const raw of outputs) {
            const restored = restoreHistoryItem(raw);
            if (restored) {
              items.push(restored);
            }
          }
        }
      }
      continue;
    }
    switch (record.type) {
      case 'user': {
        // Flush any pending tool group before user message
        if (currentToolGroup.length > 0) {
          items.push({
            type: 'tool_group',
            tools: [...currentToolGroup],
          });
          currentToolGroup = [];
        }

        const text = extractTextFromParts(record.message?.parts as Part[]);
        if (text) {
          items.push({ type: 'user', text });
        }
        break;
      }

      case 'assistant': {
        const parts = record.message?.parts as Part[] | undefined;

        // Extract thought content
        const thoughtText = !config
          .getContentGenerator()
          .useSummarizedThinking()
          ? extractThoughtTextFromParts(parts)
          : '';

        // Extract text content (non-function-call, non-thought)
        const text = extractTextFromParts(parts);

        // Extract function calls
        const functionCalls = extractFunctionCalls(parts);

        // If there's thought content, add it as a gemini_thought message
        if (thoughtText) {
          // Flush any pending tool group before thought
          if (currentToolGroup.length > 0) {
            items.push({
              type: 'tool_group',
              tools: [...currentToolGroup],
            });
            currentToolGroup = [];
          }
          items.push({ type: 'gemini_thought', text: thoughtText });
        }

        // If there's text content, add it as a gemini message
        if (text) {
          // Flush any pending tool group before text
          if (currentToolGroup.length > 0) {
            items.push({
              type: 'tool_group',
              tools: [...currentToolGroup],
            });
            currentToolGroup = [];
          }
          items.push({ type: 'gemini', text });
        }

        // Track function calls for pairing with results
        for (const fc of functionCalls) {
          const tool = getTool(config, fc.name);

          pendingToolCalls.set(fc.id, { name: fc.name, args: fc.args });

          // Add placeholder tool call to current group
          currentToolGroup.push({
            callId: fc.id,
            name: tool?.displayName || fc.name,
            description: tool ? formatToolDescription(tool, fc.args) : '',
            resultDisplay: undefined,
            status: ToolCallStatus.Success, // Will be updated by tool_result
            confirmationDetails: undefined,
          });
        }
        break;
      }

      case 'tool_result': {
        // Update the corresponding tool call in the current group
        if (record.toolCallResult) {
          const callId = record.toolCallResult.callId;
          const toolCall = currentToolGroup.find((t) => t.callId === callId);
          if (toolCall) {
            // Preserve the resultDisplay as-is - it can be a string or structured object
            const rawDisplay = record.toolCallResult.resultDisplay;
            toolCall.resultDisplay = rawDisplay;
            // Check if status exists and use it
            const rawStatus = (
              record.toolCallResult as Record<string, unknown>
            )['status'] as string | undefined;
            toolCall.status =
              rawStatus === 'error'
                ? ToolCallStatus.Error
                : ToolCallStatus.Success;
          }
          pendingToolCalls.delete(callId || '');
        }
        break;
      }

      default:
        // Skip unknown record types
        break;
    }
  }

  // Flush any remaining tool group
  if (currentToolGroup.length > 0) {
    items.push({
      type: 'tool_group',
      tools: currentToolGroup,
    });
  }

  return items;
}

/**
 * Builds the complete UI history items for a resumed session.
 *
 * This function takes the resumed session data, converts it to UI history format,
 * and assigns unique IDs to each item for use with loadHistory.
 *
 * @param sessionData The resumed session data from SessionService
 * @param config The config object for accessing tool registry
 * @param baseTimestamp Base timestamp for generating unique IDs
 * @returns Array of HistoryItem with proper IDs
 */
export function buildResumedHistoryItems(
  sessionData: ResumedSessionData,
  config: Config,
  baseTimestamp: number = Date.now(),
): HistoryItem[] {
  const items: HistoryItem[] = [];
  let idCounter = 1;

  const getNextId = (): number => baseTimestamp + idCounter++;

  // Convert conversation directly to history items
  const historyItems = convertToHistoryItems(sessionData.conversation, config);
  for (const item of historyItems) {
    items.push({
      ...item,
      id: getNextId(),
    } as HistoryItem);
  }

  return items;
}
