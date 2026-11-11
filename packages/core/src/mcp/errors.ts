/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from '../utils/errors.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { ToolResult } from '../tools/tools.js';
import {
  formatErrorDiagnostic,
  getErrorDiagnostic,
} from '../utils/error-fields.js';

export function getMcpErrorMessage(error: unknown): string {
  const diagnostic = getErrorDiagnostic(error);
  if (
    diagnostic?.errorCauseName ||
    diagnostic?.errorCauseMessage ||
    diagnostic?.errorCauseCode
  ) {
    return formatErrorDiagnostic(diagnostic);
  }
  return getErrorMessage(error);
}

export function isStructuredTimeoutError(error: unknown): boolean {
  const seen = new Set<object>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const record = error as { name?: unknown; code?: unknown; cause?: unknown };
    if (
      record.name === 'TimeoutError' ||
      record.code === ErrorCode.RequestTimeout ||
      record.code === 'ETIMEDOUT' ||
      record.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      record.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      record.code === 'UND_ERR_BODY_TIMEOUT' ||
      record.code === 'ERR_MCP_REQUEST_TIMEOUT'
    )
      return true;
    error = record.cause;
  }
  return false;
}

/** Execution failures are not server-returned MCP business results. */
export function createMcpToolErrorResult(error: unknown): ToolResult {
  const message = getMcpErrorMessage(error);
  const diagnostic = getErrorDiagnostic(error);
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message, type: ToolErrorType.MCP_TOOL_ERROR },
    data: {
      mcp_operation_outcome: isStructuredTimeoutError(error)
        ? 'timeout'
        : 'transport_error',
      mcp_server_responded: false,
      ...(diagnostic ? { mcp_error: diagnostic } : {}),
    },
  };
}
