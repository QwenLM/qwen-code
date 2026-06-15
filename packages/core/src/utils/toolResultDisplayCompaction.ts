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
  TaskListResultDisplay,
  TeamResultDisplay,
  TodoResultDisplay,
  ToolResultDisplay,
} from '../tools/tools.js';
import type { AnsiLine, AnsiOutput } from './terminalSerializer.js';

export const MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS = 32_000;
export const MAX_RETAINED_AGENT_FIELD_CHARS = 8_000;
export const MAX_RETAINED_FILE_DIFF_CHARS = 50_000;
export const MAX_RETAINED_FILE_CONTENT_CHARS = 16_000;
export const MAX_RETAINED_ANSI_OUTPUT_LINES = 200;

type CompactionPurpose = 'history' | 'recording';

function copyString(value: string): string {
  return value.split('').join('');
}

function buildStringCompactionMarker(
  value: string,
  purpose: CompactionPurpose,
): string {
  if (purpose === 'recording') {
    return `\n[... truncated for saved session preview; original length: ${value.length} characters ...]\n`;
  }

  return `\n[... truncated from ${value.length} characters for CLI history display ...]\n`;
}

function buildAnsiOutputCompactionMarker(
  omitted: number,
  purpose: CompactionPurpose,
): string {
  const target =
    purpose === 'recording' ? 'saved session preview' : 'CLI history display';
  return `[... ${omitted} terminal lines omitted from ${target} ...]`;
}

function compactString(
  value: string,
  purpose: CompactionPurpose,
  limit = MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
): string {
  if (value.length <= limit) {
    return value;
  }

  const marker = buildStringCompactionMarker(value, purpose);
  const contentBudget = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(contentBudget * 0.6);
  const tailLength = contentBudget - headLength;
  const head = copyString(value.slice(0, headLength));
  const tail =
    tailLength > 0 ? copyString(value.slice(value.length - tailLength)) : '';

  return head + marker + tail;
}

export function compactStringForHistory(
  value: string,
  limit = MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
): string {
  return compactString(value, 'history', limit);
}

export function compactStringForRecording(
  value: string,
  limit = MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
): string {
  return compactString(value, 'recording', limit);
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

function compactFileDiff(
  display: FileDiff,
  purpose: CompactionPurpose,
): FileDiff {
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
    fileDiff: compactString(
      display.fileDiff,
      purpose,
      MAX_RETAINED_FILE_DIFF_CHARS,
    ),
    originalContent:
      typeof display.originalContent === 'string'
        ? compactString(
            display.originalContent,
            purpose,
            MAX_RETAINED_FILE_CONTENT_CHARS,
          )
        : display.originalContent,
    newContent: compactString(
      display.newContent,
      purpose,
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

function compactAnsiLine(line: AnsiLine, purpose: CompactionPurpose): AnsiLine {
  let changed = false;
  const compactedLine = line.map((token) => {
    const compactedText = compactString(token.text, purpose);
    if (compactedText !== token.text) {
      changed = true;
      return {
        ...token,
        text: compactedText,
      };
    }

    return token;
  });
  return changed ? compactedLine : line;
}

function compactAnsiOutput(
  output: AnsiOutput,
  purpose: CompactionPurpose,
): AnsiOutput {
  if (output.length <= MAX_RETAINED_ANSI_OUTPUT_LINES) {
    let changed = false;
    const compactedOutput = output.map((line) => {
      const compactedLine = compactAnsiLine(line, purpose);
      if (compactedLine !== line) {
        changed = true;
      }
      return compactedLine;
    });
    return changed ? compactedOutput : output;
  }

  const omitted = output.length - MAX_RETAINED_ANSI_OUTPUT_LINES + 1;
  return [
    markerAnsiLine(buildAnsiOutputCompactionMarker(omitted, purpose)),
    ...output
      .slice(-(MAX_RETAINED_ANSI_OUTPUT_LINES - 1))
      .map((line) => compactAnsiLine(line, purpose)),
  ];
}

function compactAnsiOutputDisplay(
  display: AnsiOutputDisplay,
  purpose: CompactionPurpose,
): AnsiOutputDisplay {
  const ansiOutput = compactAnsiOutput(display.ansiOutput, purpose);
  if (ansiOutput === display.ansiOutput) {
    return display;
  }

  return {
    ...display,
    ansiOutput,
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

function compactAgentResultDisplay(
  display: AgentResultDisplay,
  purpose: CompactionPurpose,
): AgentResultDisplay {
  return {
    ...display,
    taskDescription: compactString(
      display.taskDescription,
      purpose,
      MAX_RETAINED_AGENT_FIELD_CHARS,
    ),
    taskPrompt: compactString(
      display.taskPrompt,
      purpose,
      MAX_RETAINED_AGENT_FIELD_CHARS,
    ),
    ...(display.terminateReason !== undefined && {
      terminateReason: compactString(
        display.terminateReason,
        purpose,
        MAX_RETAINED_AGENT_FIELD_CHARS,
      ),
    }),
    ...(display.result !== undefined && {
      result: compactString(
        display.result,
        purpose,
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
            description: compactString(
              description,
              purpose,
              MAX_RETAINED_AGENT_FIELD_CHARS,
            ),
          }),
          ...(error !== undefined && {
            error: compactString(
              error,
              purpose,
              MAX_RETAINED_AGENT_FIELD_CHARS,
            ),
          }),
          ...(resultDisplay !== undefined && {
            resultDisplay: compactString(resultDisplay, purpose),
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
  purpose: CompactionPurpose,
): TodoResultDisplay {
  return {
    ...display,
    todos: display.todos.map((todo) => ({
      ...todo,
      content: compactString(
        todo.content,
        purpose,
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
  purpose: CompactionPurpose,
): PlanResultDisplay {
  return {
    ...display,
    message: compactString(
      display.message,
      purpose,
      MAX_RETAINED_AGENT_FIELD_CHARS,
    ),
    plan: compactString(
      display.plan,
      purpose,
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
  purpose: CompactionPurpose,
): McpToolProgressData {
  return {
    ...display,
    ...(display.message !== undefined && {
      message: compactString(
        display.message,
        purpose,
        MAX_RETAINED_AGENT_FIELD_CHARS,
      ),
    }),
  };
}

function isTeamResultDisplay(
  resultDisplay: unknown,
): resultDisplay is TeamResultDisplay {
  return (
    typeof resultDisplay === 'object' &&
    resultDisplay !== null &&
    'type' in resultDisplay &&
    resultDisplay.type === 'team_result'
  );
}

function compactTeamResultDisplay(
  display: TeamResultDisplay,
  purpose: CompactionPurpose,
): TeamResultDisplay {
  return {
    ...display,
    teamName: compactString(
      display.teamName,
      purpose,
      MAX_RETAINED_AGENT_FIELD_CHARS,
    ),
  };
}

function isTaskListResultDisplay(
  resultDisplay: unknown,
): resultDisplay is TaskListResultDisplay {
  return (
    typeof resultDisplay === 'object' &&
    resultDisplay !== null &&
    'type' in resultDisplay &&
    resultDisplay.type === 'task_list'
  );
}

function compactTaskListResultDisplay(
  display: TaskListResultDisplay,
  purpose: CompactionPurpose,
): TaskListResultDisplay {
  return {
    ...display,
    tasks: display.tasks.map((task) => ({
      ...task,
      subject: compactString(
        task.subject,
        purpose,
        MAX_RETAINED_AGENT_FIELD_CHARS,
      ),
      ...(task.owner !== undefined && {
        owner: compactString(
          task.owner,
          purpose,
          MAX_RETAINED_AGENT_FIELD_CHARS,
        ),
      }),
    })),
  };
}

function compactToolResultDisplay<T extends ToolResultDisplay | undefined>(
  resultDisplay: T,
  purpose: CompactionPurpose,
): T {
  if (typeof resultDisplay === 'string') {
    return compactString(resultDisplay, purpose) as T;
  }

  if (resultDisplay === undefined) {
    return resultDisplay;
  }

  if (isFileDiffDisplay(resultDisplay)) {
    return compactFileDiff(resultDisplay, purpose) as T;
  }

  if (isAgentResultDisplay(resultDisplay)) {
    return compactAgentResultDisplay(resultDisplay, purpose) as T;
  }

  if (isAnsiOutputDisplay(resultDisplay)) {
    return compactAnsiOutputDisplay(resultDisplay, purpose) as T;
  }

  if (isTodoResultDisplay(resultDisplay)) {
    return compactTodoResultDisplay(resultDisplay, purpose) as T;
  }

  if (isPlanResultDisplay(resultDisplay)) {
    return compactPlanResultDisplay(resultDisplay, purpose) as T;
  }

  if (isMcpToolProgressData(resultDisplay)) {
    return compactMcpToolProgressData(resultDisplay, purpose) as T;
  }

  if (isTeamResultDisplay(resultDisplay)) {
    return compactTeamResultDisplay(resultDisplay, purpose) as T;
  }

  if (isTaskListResultDisplay(resultDisplay)) {
    return compactTaskListResultDisplay(resultDisplay, purpose) as T;
  }

  return resultDisplay;
}

export function compactToolResultDisplayForHistory<
  T extends ToolResultDisplay | undefined,
>(resultDisplay: T): T {
  return compactToolResultDisplay(resultDisplay, 'history');
}

export function compactToolResultDisplayForRecording<
  T extends ToolResultDisplay | undefined,
>(resultDisplay: T): T {
  return compactToolResultDisplay(resultDisplay, 'recording');
}
