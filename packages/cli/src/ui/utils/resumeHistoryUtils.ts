/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, FunctionCall } from '@google/genai';
import type {
  ResumedSessionData,
  ConversationRecord,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import { ToolCallStatus } from '../types.js';

/**
 * UI history item types for session resume display.
 */
export interface ResumeHistoryItemUser {
  type: 'user';
  text: string;
}

export interface ResumeHistoryItemGemini {
  type: 'gemini';
  text: string;
}

export interface ResumeHistoryItemToolCall {
  callId: string;
  name: string;
  description: string;
  resultDisplay: string | undefined;
  status: 'Success' | 'Error' | 'Canceled';
}

export interface ResumeHistoryItemToolGroup {
  type: 'tool_group';
  tools: ResumeHistoryItemToolCall[];
}

export interface ResumeHistoryItemInfo {
  type: 'info';
  text: string;
}

export type ResumeHistoryItem =
  | ResumeHistoryItemUser
  | ResumeHistoryItemGemini
  | ResumeHistoryItemToolGroup
  | ResumeHistoryItemInfo;

/**
 * Extracts text content from a Content object's parts.
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

/**
 * Truncates a string to a maximum length.
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Formats a tool description from its name and arguments.
 */
function formatToolDescription(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case 'read_file':
      return `Read file: ${args['target_file'] || args['path'] || 'unknown'}`;
    case 'write_file':
      return `Write file: ${args['target_file'] || args['path'] || 'unknown'}`;
    case 'edit':
      return `Edit file: ${args['file_path'] || args['path'] || 'unknown'}`;
    case 'run_shell_command':
    case 'shell':
      return `Run: ${truncate(String(args['command'] || ''), 60)}`;
    case 'glob':
      return `Find files: ${args['pattern'] || 'unknown'}`;
    case 'grep':
      return `Search: ${truncate(String(args['pattern'] || ''), 40)}`;
    case 'list_directory':
    case 'ls':
      return `List: ${args['path'] || args['directory'] || '.'}`;
    case 'web_search':
      return `Search web: ${truncate(String(args['query'] || ''), 40)}`;
    case 'web_fetch':
      return `Fetch: ${truncate(String(args['url'] || ''), 50)}`;
    default:
      return name;
  }
}

/**
 * Formats tool result for display.
 */
function formatToolResult(parts: Part[] | undefined): string | undefined {
  if (!parts) return undefined;

  for (const part of parts) {
    if ('functionResponse' in part && part.functionResponse) {
      const response = part.functionResponse.response;
      if (typeof response === 'string') {
        return truncate(response, 200);
      }
      if (response && typeof response === 'object') {
        const result = (response as Record<string, unknown>)['result'];
        if (typeof result === 'string') {
          return truncate(result, 200);
        }
      }
    }
  }
  return undefined;
}

/**
 * Converts ChatRecord messages to UI history items for display.
 *
 * This function transforms the raw ChatRecords into a format suitable
 * for the CLI's HistoryItemDisplay component.
 *
 * @param conversation The conversation record from a resumed session
 * @returns Array of history items for UI display
 */
export function convertToUiHistory(
  conversation: ConversationRecord,
): ResumeHistoryItem[] {
  const items: ResumeHistoryItem[] = [];

  // Track pending tool calls for grouping with results
  const pendingToolCalls = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  let currentToolGroup: ResumeHistoryItemToolCall[] = [];

  for (const record of conversation.messages) {
    switch (record.type) {
      case 'user': {
        // Flush any pending tool group before user message
        if (currentToolGroup.length > 0) {
          items.push({ type: 'tool_group', tools: [...currentToolGroup] });
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

        // Extract text content (non-function-call, non-thought)
        const text = extractTextFromParts(parts);

        // Extract function calls
        const functionCalls = extractFunctionCalls(parts);

        // If there's text content, add it as a gemini message
        if (text) {
          // Flush any pending tool group before text
          if (currentToolGroup.length > 0) {
            items.push({ type: 'tool_group', tools: [...currentToolGroup] });
            currentToolGroup = [];
          }
          items.push({ type: 'gemini', text });
        }

        // Track function calls for pairing with results
        for (const fc of functionCalls) {
          pendingToolCalls.set(fc.id, { name: fc.name, args: fc.args });

          // Add placeholder tool call to current group
          currentToolGroup.push({
            callId: fc.id,
            name: fc.name,
            description: formatToolDescription(fc.name, fc.args),
            resultDisplay: undefined,
            status: 'Success', // Will be updated by tool_result
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
            // Convert resultDisplay to string if needed
            const rawDisplay = record.toolCallResult.resultDisplay;
            toolCall.resultDisplay =
              typeof rawDisplay === 'string'
                ? rawDisplay
                : formatToolResult(record.message?.parts as Part[] | undefined);
            // Check if status exists and use it
            const rawStatus = (
              record.toolCallResult as Record<string, unknown>
            )['status'] as string | undefined;
            toolCall.status = rawStatus === 'error' ? 'Error' : 'Success';
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
    items.push({ type: 'tool_group', tools: currentToolGroup });
  }

  return items;
}

/**
 * Creates a session resume info message for display.
 */
export function createResumeInfoMessage(
  sessionData: ResumedSessionData,
): ResumeHistoryItemInfo {
  const { conversation } = sessionData;
  const messageCount = conversation.messages.length;
  const startTime = new Date(conversation.startTime).toLocaleString();

  return {
    type: 'info',
    text: `Resumed session from ${startTime} (${messageCount} messages)`,
  };
}

/**
 * Converts a single ResumeHistoryItem to a HistoryItemWithoutId.
 */
function convertResumeItem(item: ResumeHistoryItem): HistoryItemWithoutId {
  switch (item.type) {
    case 'user':
      return { type: 'user', text: item.text };
    case 'gemini':
      return { type: 'gemini', text: item.text };
    case 'info':
      return { type: 'info', text: item.text };
    case 'tool_group':
      return {
        type: 'tool_group',
        tools: item.tools.map((tool) => ({
          callId: tool.callId,
          name: tool.name,
          description: tool.description,
          resultDisplay: tool.resultDisplay,
          status:
            tool.status === 'Success'
              ? ToolCallStatus.Success
              : tool.status === 'Error'
                ? ToolCallStatus.Error
                : ToolCallStatus.Canceled,
          confirmationDetails: undefined,
        })),
      };
    default: {
      // This should never happen since we handle all ResumeHistoryItem types
      const _exhaustiveCheck: never = item;
      throw new Error(`Unknown resume item type: ${_exhaustiveCheck}`);
    }
  }
}

/**
 * Builds the complete UI history items for a resumed session.
 *
 * This function takes the resumed session data, converts it to UI history format,
 * and assigns unique IDs to each item for use with loadHistory.
 *
 * @param sessionData The resumed session data from SessionService
 * @param baseTimestamp Base timestamp for generating unique IDs
 * @returns Array of HistoryItem with proper IDs
 */
export function buildResumedHistoryItems(
  sessionData: ResumedSessionData,
  baseTimestamp: number = Date.now(),
): HistoryItem[] {
  const items: HistoryItem[] = [];
  let idCounter = 1;

  const getNextId = (): number => baseTimestamp + idCounter++;

  // Add resume info message first
  const resumeInfo = createResumeInfoMessage(sessionData);
  items.push({
    id: getNextId(),
    type: 'info',
    text: resumeInfo.text,
  });

  // Convert and add resumed history items
  const uiHistory = convertToUiHistory(sessionData.conversation);
  for (const item of uiHistory) {
    const converted = convertResumeItem(item);
    items.push({
      ...converted,
      id: getNextId(),
    } as HistoryItem);
  }

  return items;
}
