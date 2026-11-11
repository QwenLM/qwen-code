/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isTool,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
} from '../tools/tools.js';
import { SHELL_TOOL_NAMES } from './shell-utils.js';
import levenshtein from 'fast-levenshtein';
import {
  CoreToolCallStatus,
  type ToolCallResponseInfo,
} from '../tool-executor/types.js';
import {
  ASK_USER_DISPLAY_NAME,
  WRITE_FILE_DISPLAY_NAME,
  EDIT_DISPLAY_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from '../tools/tool-names.js';

const TASK_PANEL_TOOL_NAMES = new Set([
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]);

/**
 * Validates if an object is a ToolCallResponseInfo.
 */
export function isToolCallResponseInfo(
  data: unknown,
): data is ToolCallResponseInfo {
  return (
    typeof data === 'object' &&
    data !== null &&
    'callId' in data &&
    'responseParts' in data
  );
}

/**
 * Options for determining if a tool call should be hidden in the CLI history.
 */
export interface ShouldHideToolCallParams {
  /** The protocol-level tool name used to identify the tool. */
  toolName: string;
  /** The current status of the tool call. */
  status: CoreToolCallStatus;
  /** Whether the tool has produced a result for display. */
  hasResultDisplay: boolean;
  /** The ID of the parent tool call, if any. */
  parentCallId?: string;
  /** Whether plan mode was active when the tool was called. */
  planModeActive?: boolean;
  /** Validated tool input used by tool-specific visibility rules. */
  input?: Record<string, unknown>;
}

/**
 * Determines if a tool call should be hidden from the standard tool history UI.
 *
 * We hide tools in several cases:
 * 1. Tool calls that have a parent, as they are "internal" to another tool (e.g. subagent).
 * 2. Ask User tools that are in progress, displayed via specialized UI.
 * 3. Ask User tools that errored without result display, typically param
 *    validation errors that the agent automatically recovers from.
 * 4. WriteFile and Edit tools when in Plan Mode, redundant because the
 *    resulting plans are displayed separately upon exiting plan mode.
 * 5. Persistent task tools, whose current state is displayed in the task panel.
 */
export function shouldHideToolCall(params: ShouldHideToolCallParams): boolean {
  const {
    toolName,
    status,
    hasResultDisplay,
    parentCallId,
    planModeActive,
  } = params;

  if (parentCallId) {
    return true;
  }

  if (TASK_PANEL_TOOL_NAMES.has(toolName)) {
    return true;
  }

  switch (toolName) {
    case ASK_USER_DISPLAY_NAME:
      switch (status) {
        case CoreToolCallStatus.Scheduled:
        case CoreToolCallStatus.Validating:
        case CoreToolCallStatus.Executing:
        case CoreToolCallStatus.AwaitingApproval:
          return true;
        case CoreToolCallStatus.Error:
          return !hasResultDisplay;
        default:
          return false;
      }
    case WRITE_FILE_DISPLAY_NAME:
    case EDIT_DISPLAY_NAME:
      // Plans are shown separately when plan mode exits, so the edits that built
      // them are redundant in the history. This used to fall back to
      // `permissionMode === 'plan'`, which could never be true — `plan` is not one
      // of the permission modes — so the rule had silently stopped hiding anything.
      return planModeActive ?? false;
    case SEND_MESSAGE_TOOL_NAME:
      return status !== CoreToolCallStatus.Error;
    default:
      return false;
  }
}

/**
 * Generates a suggestion string for a tool name that was not found in the registry.
 * It finds the closest matches based on Levenshtein distance.
 * @param unknownToolName The tool name that was not found.
 * @param allToolNames The list of all available tool names.
 * @param topN The number of suggestions to return. Defaults to 3.
 * @returns A suggestion string like " Did you mean 'tool'?" or " Did you mean one of: 'tool1', 'tool2'?", or an empty string if no suggestions are found.
 */
export function getToolSuggestion(
  unknownToolName: string,
  allToolNames: string[],
  topN = 3,
): string {
  const matches = allToolNames.map((toolName) => ({
    name: toolName,
    distance: levenshtein.get(unknownToolName, toolName),
  }));

  matches.sort((a, b) => a.distance - b.distance);

  const topNResults = matches.slice(0, topN);

  if (topNResults.length === 0) {
    return '';
  }

  const suggestedNames = topNResults
    .map((match) => `"${match.name}"`)
    .join(', ');

  if (topNResults.length > 1) {
    return ` Did you mean one of: ${suggestedNames}?`;
  } else {
    return ` Did you mean ${suggestedNames}?`;
  }
}

// ---------------------------------------------------------------------------
// Tool Status Helpers (shared by state-manager, ste-bridge, tool-executor)
// ---------------------------------------------------------------------------

/**
 * Converts a cancellation / error reason into a short, period-terminated summary
 * suitable for the `toolUseResult.summary` field.
 *
 * Strips `[Operation Cancelled] Reason:` prefixes and normalises common
 * patterns ("user cancelled", "user pressed esc") to a single human-friendly
 * string.
 */
export function toToolStatusSummary(reason: string | undefined): string {
  if (!reason) {
    return 'Operation cancelled.';
  }

  if (/user cancelled/i.test(reason) || /user pressed esc/i.test(reason)) {
    return 'User cancelled.';
  }

  if (/operation cancelled/i.test(reason)) {
    return 'User cancelled.';
  }

  const cleaned = reason.replace(
    /^\[Operation Cancelled\]\s*(Reason:\s*)?/i,
    '',
  );
  return cleaned.endsWith('.') ? cleaned : `${cleaned}.`;
}

/**
 * Returns true when the cancellation message indicates the tool was actively
 * denied / rejected by the user (as opposed to a generic abort).
 */
export function isDeniedCancellation(message: string): boolean {
  return /\bdenied\b|\brejected\b/i.test(message);
}

/**
 * Checks if a tool invocation matches any of a list of patterns.
 *
 * @param toolOrToolName The tool object or the name of the tool being invoked.
 * @param invocation The invocation object for the tool or the command invoked.
 * @param patterns A list of patterns to match against.
 *   Patterns can be:
 *   - A tool name (e.g., "ReadFileTool") to match any invocation of that tool.
 *   - A tool name with a prefix (e.g., "ShellTool(git status)") to match
 *     invocations where the arguments start with that prefix.
 * @returns True if the invocation matches any pattern, false otherwise.
 */
export function doesToolInvocationMatch(
  toolOrToolName: AnyDeclarativeTool | string,
  invocation: AnyToolInvocation | string,
  patterns: string[],
): boolean {
  let toolNames: string[];
  if (isTool(toolOrToolName)) {
    toolNames = [toolOrToolName.name, toolOrToolName.configurationName ?? toolOrToolName.constructor.name];
  } else {
    toolNames = [toolOrToolName];
  }

  if (toolNames.some((name) => SHELL_TOOL_NAMES.includes(name))) {
    toolNames = [...new Set([...toolNames, ...SHELL_TOOL_NAMES])];
  }

  for (const pattern of patterns) {
    const openParen = pattern.indexOf('(');

    if (openParen === -1) {
      // No arguments, just a tool name
      if (toolNames.includes(pattern)) {
        return true;
      }
      continue;
    }

    const patternToolName = pattern.substring(0, openParen);
    if (!toolNames.includes(patternToolName)) {
      continue;
    }

    if (!pattern.endsWith(')')) {
      continue;
    }

    const argPattern = pattern.substring(openParen + 1, pattern.length - 1);

    let command: string;
    if (typeof invocation === 'string') {
      command = invocation;
    } else {
      if (!('command' in invocation.params)) {
        // This invocation has no command - nothing to check.
        continue;
      }
      command = String((invocation.params as { command: string }).command);
    }

    if (toolNames.some((name) => SHELL_TOOL_NAMES.includes(name))) {
      if (command === argPattern || command.startsWith(argPattern + ' ')) {
        return true;
      }
    }
  }

  return false;
}
