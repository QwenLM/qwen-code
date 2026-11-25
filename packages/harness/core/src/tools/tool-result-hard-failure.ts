/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolErrorType } from './tool-error.js';

/**
 * Qhub-facing hard failure classification for tool results.
 *
 * This intentionally does not change tool execution semantics. A tool result
 * may still be `is_error=true` for model recovery while not being a product
 * hard failure for reporting/display.
 */
export function isHardToolFailure(
  errorType: ToolErrorType | undefined,
  message: string,
): boolean {
  switch (errorType) {
    case ToolErrorType.INVALID_TOOL_PARAMS:
    case ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED:
    case ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE:
    case ToolErrorType.FILE_NOT_FOUND:
    case ToolErrorType.SEARCH_PATH_NOT_FOUND:
    case ToolErrorType.SEARCH_PATH_NOT_A_DIRECTORY:
    case ToolErrorType.FILE_TOO_LARGE:
    case ToolErrorType.TARGET_IS_DIRECTORY:
    case ToolErrorType.EDIT_NO_OCCURRENCE_FOUND:
    case ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH:
    case ToolErrorType.EDIT_NO_CHANGE:
    case ToolErrorType.EDIT_NO_CHANGE_LLM_JUDGEMENT:
    case ToolErrorType.EDIT_PREPARATION_FAILURE:
    case ToolErrorType.PATH_NOT_IN_WORKSPACE:
    case ToolErrorType.PERMISSION_DENIED:
    case ToolErrorType.POLICY_VIOLATION:
    case ToolErrorType.SETTINGS_VALIDATION_FAILED:
    case ToolErrorType.GLOB_EXECUTION_ERROR:
    case ToolErrorType.GREP_EXECUTION_ERROR:
    case ToolErrorType.WEB_FETCH_NO_URL_IN_PROMPT:
    case ToolErrorType.IMAGE_GEN_CONTENT_SAFETY_REJECTED:
    case ToolErrorType.STOP_EXECUTION:
      return false;

    case ToolErrorType.READ_CONTENT_FAILURE:
      return !isKnownNonHardReadFailure(message);

    case ToolErrorType.UNHANDLED_EXCEPTION:
    case ToolErrorType.TOOL_NOT_REGISTERED:
    case ToolErrorType.EXECUTION_FAILED:
    case ToolErrorType.NO_SPACE_LEFT:
    case ToolErrorType.FILE_WRITE_FAILURE:
    case ToolErrorType.SHELL_EXECUTE_ERROR:
    case ToolErrorType.MCP_TOOL_ERROR:
      return true;

    default:
      return true;
  }
}

export function attachIsHardFailure(
  toolUseResult: unknown,
  isHardFailure: boolean,
): unknown {
  if (
    toolUseResult &&
    typeof toolUseResult === 'object' &&
    !Array.isArray(toolUseResult)
  ) {
    return {
      ...toolUseResult,
      isHardFailure,
    };
  }

  if (toolUseResult === undefined) {
    return { isHardFailure };
  }

  return {
    value: toolUseResult,
    isHardFailure,
  };
}

function isKnownNonHardReadFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('pdftoppm') ||
    lower.includes('poppler') ||
    lower.includes('not installed') ||
    lower.includes('not supported with the current configuration') ||
    lower.includes('cannot read binary files')
  );
}
