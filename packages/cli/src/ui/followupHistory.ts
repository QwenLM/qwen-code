/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  extractSuggestionContext,
  type SuggestionContext,
  type ToolResultDisplay,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem, IndividualToolCallDisplay } from './types.js';
import { ToolCallStatus } from './types.js';

type ModifiedFile = SuggestionContext['modifiedFiles'][number];
type FollowupToolCall = SuggestionContext['toolCalls'][number];

const WRITE_FILE_CREATED_MESSAGE =
  'Successfully created and wrote to new file:';
const WRITE_FILE_OVERWROTE_MESSAGE = 'Successfully overwrote file:';
const WRITE_PREFIX = 'Writing to ';
const CREATE_PREFIX = 'Create ';

function parseToolPath(description: string): string {
  if (description.startsWith(WRITE_PREFIX)) {
    return description.slice(WRITE_PREFIX.length);
  }

  if (description.startsWith(CREATE_PREFIX)) {
    return description.slice(CREATE_PREFIX.length);
  }

  const separatorIndex = description.indexOf(':');
  if (separatorIndex > 0) {
    return description.slice(0, separatorIndex);
  }

  return '(file)';
}

function inferWriteFileChangeType(
  resultDisplay: ToolResultDisplay | string | undefined,
): ModifiedFile['type'] {
  if (typeof resultDisplay === 'string') {
    if (resultDisplay.includes(WRITE_FILE_CREATED_MESSAGE)) {
      return 'created';
    }

    if (resultDisplay.includes(WRITE_FILE_OVERWROTE_MESSAGE)) {
      return 'edited';
    }
  }

  // History does not reliably preserve whether WriteFile created or replaced
  // an existing file. Fall back to the safer edited classification.
  return 'edited';
}

function mapToolStatus(status: ToolCallStatus): FollowupToolCall['status'] {
  if (status === ToolCallStatus.Error) {
    return 'error';
  }

  if (status === ToolCallStatus.Canceled) {
    return 'cancelled';
  }

  return 'success';
}

export function extractModifiedFileFromTool(
  tool: IndividualToolCallDisplay,
): ModifiedFile | null {
  if (tool.name === 'Edit') {
    return {
      path: parseToolPath(tool.description),
      type: tool.description.startsWith(CREATE_PREFIX) ? 'created' : 'edited',
    };
  }

  if (tool.name === 'WriteFile') {
    return {
      path: parseToolPath(tool.description),
      type: inferWriteFileChangeType(tool.resultDisplay),
    };
  }

  return null;
}

export function extractFollowupSuggestionContext(
  history: HistoryItem[],
): SuggestionContext | null {
  const lastUserIndex = history.findLastIndex((item) => item.type === 'user');
  const turnItems = history.slice(lastUserIndex >= 0 ? lastUserIndex + 1 : 0);

  const lastGeminiItem = turnItems.findLast(
    (item): item is Extract<HistoryItem, { type: 'gemini' }> =>
      item.type === 'gemini',
  );
  if (!lastGeminiItem) {
    return null;
  }

  const recentToolItems = turnItems
    .filter(
      (item): item is Extract<HistoryItem, { type: 'tool_group' }> =>
        item.type === 'tool_group',
    )
    .flatMap((item) => item.tools)
    .slice(-10);

  if (recentToolItems.length === 0) {
    return null;
  }

  const toolCalls = recentToolItems.map((tool) => ({
    name: tool.name,
    input: {},
    status: mapToolStatus(tool.status),
  }));

  const modifiedFiles = recentToolItems
    .map(extractModifiedFileFromTool)
    .filter((file): file is ModifiedFile => file !== null);

  const hasError = toolCalls.some((tool) => tool.status === 'error');
  const wasCancelled = toolCalls.some((tool) => tool.status === 'cancelled');

  return extractSuggestionContext({
    lastMessage: lastGeminiItem.text.slice(0, 1000),
    toolCalls,
    modifiedFiles,
    hasError,
    wasCancelled,
  });
}
