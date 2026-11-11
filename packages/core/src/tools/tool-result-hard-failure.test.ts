/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolErrorType } from './tool-error.js';
import {
  attachIsHardFailure,
  isHardToolFailure,
} from './tool-result-hard-failure.js';

describe('tool result hard failure classification', () => {
  it.each([
    ToolErrorType.INVALID_TOOL_PARAMS,
    ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
    ToolErrorType.PATH_NOT_IN_WORKSPACE,
    ToolErrorType.PERMISSION_DENIED,
    ToolErrorType.FILE_NOT_FOUND,
    ToolErrorType.STOP_EXECUTION,
    ToolErrorType.EDIT_PREPARATION_FAILURE,
    ToolErrorType.GLOB_EXECUTION_ERROR,
    ToolErrorType.GREP_EXECUTION_ERROR,
    ToolErrorType.WEB_FETCH_NO_URL_IN_PROMPT,
    ToolErrorType.IMAGE_GEN_CONTENT_SAFETY_REJECTED,
  ])('marks recoverable or policy error %s as non-hard', (errorType) => {
    expect(isHardToolFailure(errorType, 'tool feedback')).toBe(false);
  });

  it.each([
    'pdftoppm is not installed.',
    'Page extraction requires poppler-utils.',
    'Reading full PDFs is not supported with the current configuration.',
    'This tool cannot read binary files.',
  ])('marks known read boundary "%s" as non-hard', (message) => {
    expect(isHardToolFailure(ToolErrorType.READ_CONTENT_FAILURE, message)).toBe(
      false,
    );
  });

  it.each([
    ToolErrorType.UNHANDLED_EXCEPTION,
    ToolErrorType.EXECUTION_FAILED,
    ToolErrorType.NO_SPACE_LEFT,
    ToolErrorType.FILE_WRITE_FAILURE,
    ToolErrorType.SHELL_EXECUTE_ERROR,
    ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
    ToolErrorType.WEB_SEARCH_FAILED,
    ToolErrorType.IMAGE_SEARCH_FAILED,
    ToolErrorType.IMAGE_GEN_FAILED,
    ToolErrorType.IMAGE_GEN_BACKEND_FAILED,
    ToolErrorType.IMAGE_GEN_INVALID_RESPONSE,
    ToolErrorType.IMAGE_GEN_SESSION_CONTEXT_INVALID,
  ])('marks hard error %s as hard failure', (errorType) => {
    expect(isHardToolFailure(errorType, 'boom')).toBe(true);
  });

  it('defaults unknown errors to hard failure', () => {
    expect(isHardToolFailure(undefined, 'unknown')).toBe(true);
    expect(isHardToolFailure(ToolErrorType.UNKNOWN, 'unknown')).toBe(true);
  });

  it('attaches isHardFailure to object, missing, and primitive results', () => {
    expect(attachIsHardFailure({ existing: true }, false)).toEqual({
      existing: true,
      isHardFailure: false,
    });
    expect(attachIsHardFailure(undefined, true)).toEqual({
      isHardFailure: true,
    });
    expect(attachIsHardFailure('raw result', false)).toEqual({
      value: 'raw result',
      isHardFailure: false,
    });
  });
});
