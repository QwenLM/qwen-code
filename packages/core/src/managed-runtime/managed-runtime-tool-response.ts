/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import {
  convertToFunctionResponse,
  convertToFunctionErrorResponse,
} from '../core/coreToolScheduler.js';
import type { ToolResultCapture } from './managed-tool-result.js';

export interface ManagedRuntimeInlineResult {
  readonly executionStatus: 'success' | 'error' | 'cancelled' | 'not_started';
  readonly responseParts: readonly unknown[];
  readonly error?: { readonly message: string; readonly type?: string };
}

/** The same conversion supplies live model history and retirement comparison. */
export function convertManagedRuntimeToolResult(
  toolName: string,
  callId: string,
  result: ManagedRuntimeInlineResult,
  capture: ToolResultCapture | null | undefined,
): Part[] {
  const responseParts = result.responseParts as Part[];
  if (
    responseParts.some(
      (part) =>
        !part ||
        typeof part !== 'object' ||
        (typeof part.text !== 'string' && !part.inlineData && !part.fileData),
    )
  )
    throw new Error('Runtime returned an unsupported tool result.');
  const modelParts = capture?.previewTruncated
    ? [
        {
          text: `Shell execution: ${result.executionStatus}. Output preview is truncated. Complete stdout and stderr are retained in the Session result.`,
        },
        ...responseParts,
      ]
    : responseParts;
  const converted =
    result.executionStatus === 'success'
      ? convertToFunctionResponse(toolName, callId, modelParts)
      : convertToFunctionErrorResponse(
          toolName,
          callId,
          modelParts,
          result.error?.message ?? `Runtime tool ${result.executionStatus}.`,
        );
  const response = converted[0]?.functionResponse;
  if (!response || converted.length !== 1)
    throw new Error('Runtime result cannot be represented durably.');
  response.response = {
    ...response.response,
    executionStatus: result.executionStatus,
    ...(result.error ? { runtimeError: result.error } : {}),
    ...(capture !== undefined ? { capture } : {}),
  };
  return converted;
}
