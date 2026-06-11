/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentResultDisplay,
  AnsiOutputDisplay,
  FileDiff,
  McpToolProgressData,
  PlanResultDisplay,
  TodoResultDisplay,
  ToolResultDisplay,
} from '../tools/tools.js';
import type { AnsiLine, AnsiOutput } from './terminalSerializer.js';

export const MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS = 32_000;
export const MAX_RETAINED_AGENT_FIELD_CHARS = 8_000;
export const MAX_RETAINED_FILE_DIFF_CHARS = 50_000;
export const MAX_RETAINED_FILE_CONTENT_CHARS = 16_000;
export const MAX_RETAINED_ANSI_OUTPUT_LINES = 200;

function copyString(value: string): string {
  return value.split('').join('');
}

export function compactStringForHistory(
  value: string,
  limit = MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
): string {
  if (value.length <= limit) {
    return value;
  }

  const marker = `\n[... truncated from ${value.length} characters for CLI history display ...]\n`;
  const contentBudget = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(contentBudget * 0.6);
  const tailLength = contentBudget - headLength;
  const head = copyString(value.slice(0, headLength));
  const tail =
    tailLength > 0 ? copyString(value.slice(value.length - tailLength)) : '';

  return head + marker + tail;
}

function isFileDiffDisplay(resultDisplay: unknown): resultDisplay is FileDiff {
  if (
    typeof resultDisplay !== 'object' ||
    resultDisplay === null ||
    !('fileDiff' in resultDisplay) ||
    !('fileName' in resultDisplay) ||
    !('originalContent' in resultDisplay) ||
    !('newContent' in resultDisplay)
  ) {
    return false;
  }

  const display = resultDisplay as Record<string, unknown>;
  const originalContent = display['originalContent'];
  return (
    typeof display['fileDiff'] === 'string' &&
    typeof display['fileName'] === 'string' &&
    typeof display['newContent'] === 'string' &&
    (originalContent === null || typeof originalContent === 'string')
  );
}

function compactFileDiffForHistory(display: FileDiff): FileDiff {
  const fileDiffLength = display.fileDiff.length;
  const originalContentLength =
    typeof display.originalContent === 'string'
      ? display.originalContent.length
      : 0;
  const newContentLength = display.newContent.length;
  const fileDiffTruncated = fileDiffLength > MAX_RETAINED_FILE_DIFF_CHARS;
  const originalContentTruncated =
    originalContentLength > MAX_RETAINED_FILE_CONTENT_CHARS;
  const newContentTruncated =
    newContentLength > MAX_RETAINED_FILE_CONTENT_CHARS;

  if (!fileDiffTruncated && !originalContentTruncated && !newContentTruncated) {
    return display;
  }

  return {
    ...display,
    fileDiff: compactStringForHistory(
      display.fileDiff,
      MAX_RETAINED_FILE_DIFF_CHARS,
    ),
    originalContent:
      typeof display.originalContent === 'string'
        ? compactStringForHistory(
            display.originalContent,
            MAX_RETAINED_FILE_CONTENT_CHARS,
          )
        : display.originalContent,
    newContent: compactStringForHistory(
      display.newContent,
      MAX_RETAINED_FILE_CONTENT_CHARS,
    ),
    truncatedForSession: true,
    fileDiffLength,
    originalContentLength,
    newContentLength,
    fileDiffTruncated,
    originalContentTruncated,
    newContentTruncated,
  };
}

function isAnsiOutputDisplay(
  resultDisplay: unknown,
): resultDisplay is AnsiOutputDisplay {
  return (
    typeof resultDisplay === 'object' &&
    resultDisplay !== null &&
    'ansiOutput' in resultDisplay &&
    Array.isArray((resultDisplay as { ansiOutput?: unknown }).ansiOutput)
  );
}

function markerAnsiLine(text: string): AnsiLine {
  return [
    {
      text,
      bold: false,
      italic: false,
      underline: false,
      dim: true,
      inverse: false,
      fg: '',
      bg: '',
    },
  ];
}

function compactAnsiLine(line: AnsiLine): AnsiLine {
  return line.map((token) => ({
    ...token,
    text: compactStringForHistory(token.text),
  }));
}

function compactAnsiOutput(output: AnsiOutput): AnsiOutput {
  if (output.length <= MAX_RETAINED_ANSI_OUTPUT_LINES) {
    return output.map(compactAnsiLine);
  }

  const omitted = output.length - MAX_RETAINED_ANSI_OUTPUT_LINES + 1;
  return [
    markerAnsiLine(
      `[... ${omitted} terminal lines omitted from CLI history display ...]`,
    ),
    ...output.slice(-(MAX_RETAINED_ANSI_OUTPUT_LINES - 1)).map(compactAnsiLine),
  ];
}

function compactAnsiOutputDisplay(
  display: AnsiOutputDisplay,
): AnsiOutputDisplay {
  return {
    ...display,
    ansiOutput: compactAnsiOutput(display.ansiOutput),
  };
}

function isAgentResultDisplay(
  resultDisplay: unknown,
): resultDisplay is AgentResultDisplay {
  return (
    typeof resultDisplay === 'object' &&
    resultDisplay !== null &&
    'type' in resultDisplay &&
    resultDisplay.type === 'task_execution'
  );
}

function compactAgentResultDisplayForHistory(
  display: AgentResultDisplay,
): AgentResultDisplay {
  return {
    ...display,
    taskDescription: compactStringForHistory(
      display.taskDescription,
      MAX_RETAINED_AGENT_FIELD_CHARS,
    ),
    taskPrompt: compactStringForHistory(
      display.taskPrompt,
      MAX_RETAINED_AGENT_FIELD_CHARS,
    ),
    ...(display.terminateReason !== undefined && {
      terminateReason: compactStringForHistory(
        display.terminateReason,
        MAX_RETAINED_AGENT_FIELD_CHARS,
      ),
    }),
    ...(display.result !== undefined && {
      result: compactStringForHistory(
        display.result,
        MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
      ),
    }),
    ...(display.toolCalls !== undefined && {
      toolCalls: display.toolCalls.map((toolCall) => {
        const {
          args: _args,
          responseParts: _responseParts,
          result: _result,
          resultDisplay,
          error,
          description,
          ...rest
        } = toolCall;
        return {
          ...rest,
          ...(description !== undefined && {
            description: compactStringForHistory(
              description,
              MAX_RETAINED_AGENT_FIELD_CHARS,
            ),
          }),
          ...(error !== undefined && {
            error: compactStringForHistory(
              error,
              MAX_RETAINED_AGENT_FIELD_CHARS,
            ),
          }),
          ...(resultDisplay !== undefined && {
            resultDisplay: compactStringForHistory(resultDisplay),
          }),
        };
      }),
    }),
  };
}

function isTodoResultDisplay(
  resultDisplay: unknown,
): resultDisplay is TodoResultDisplay {
  return (
    typeof resultDisplay === 'object' &&
    resultDisplay !== null &&
    'type' in resultDisplay &&
    resultDisplay.type === 'todo_list'
  );
}

function compactTodoResultDisplay(
  display: TodoResultDisplay,
): TodoResultDisplay {
  return {
    ...display,
    todos: display.todos.map((todo) => ({
      ...todo,
      content: compactStringForHistory(
        todo.content,
        MAX_RETAINED_AGENT_FIELD_CHARS,
      ),
    })),
  };
}

function isPlanResultDisplay(
  resultDisplay: unknown,
): resultDisplay is PlanResultDisplay {
  return (
    typeof resultDisplay === 'object' &&
    resultDisplay !== null &&
    'type' in resultDisplay &&
    resultDisplay.type === 'plan_summary'
  );
}

function compactPlanResultDisplay(
  display: PlanResultDisplay,
): PlanResultDisplay {
  return {
    ...display,
    message: compactStringForHistory(
      display.message,
      MAX_RETAINED_AGENT_FIELD_CHARS,
    ),
    plan: compactStringForHistory(
      display.plan,
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    ),
  };
}

function isMcpToolProgressData(
  resultDisplay: unknown,
): resultDisplay is McpToolProgressData {
  return (
    typeof resultDisplay === 'object' &&
    resultDisplay !== null &&
    'type' in resultDisplay &&
    resultDisplay.type === 'mcp_tool_progress'
  );
}

function compactMcpToolProgressData(
  display: McpToolProgressData,
): McpToolProgressData {
  return {
    ...display,
    ...(display.message !== undefined && {
      message: compactStringForHistory(
        display.message,
        MAX_RETAINED_AGENT_FIELD_CHARS,
      ),
    }),
  };
}

export function compactToolResultDisplayForHistory<
  T extends ToolResultDisplay | undefined,
>(resultDisplay: T): T {
  if (typeof resultDisplay === 'string') {
    return compactStringForHistory(resultDisplay) as T;
  }

  if (resultDisplay === undefined) {
    return resultDisplay;
  }

  if (isFileDiffDisplay(resultDisplay)) {
    return compactFileDiffForHistory(resultDisplay) as T;
  }

  if (isAgentResultDisplay(resultDisplay)) {
    return compactAgentResultDisplayForHistory(resultDisplay) as T;
  }

  if (isAnsiOutputDisplay(resultDisplay)) {
    return compactAnsiOutputDisplay(resultDisplay) as T;
  }

  if (isTodoResultDisplay(resultDisplay)) {
    return compactTodoResultDisplay(resultDisplay) as T;
  }

  if (isPlanResultDisplay(resultDisplay)) {
    return compactPlanResultDisplay(resultDisplay) as T;
  }

  if (isMcpToolProgressData(resultDisplay)) {
    return compactMcpToolProgressData(resultDisplay) as T;
  }

  return resultDisplay;
}
