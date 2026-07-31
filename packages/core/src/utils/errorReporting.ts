/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('ERROR_REPORT');

interface ErrorReportData {
  error: { message: string; stack?: string } | { message: string };
  contextSummary?: unknown;
  additionalInfo?: Record<string, unknown>;
}

interface ReportErrorOptions {
  contextAlreadySummarized?: boolean;
}

type ContextSummary =
  | { kind: 'array'; itemCount: number }
  | { kind: 'object'; keys: string[] }
  | { kind: string };

function summarizeContext(context: unknown): ContextSummary {
  if (Array.isArray(context)) {
    return { kind: 'array', itemCount: context.length };
  }
  if (context && typeof context === 'object') {
    return {
      kind: 'object',
      keys: Object.keys(context).slice(0, 20),
    };
  }
  return { kind: typeof context };
}

/**
 * Generates an error report and writes it to the debug log.
 * @param error The error object.
 * @param baseMessage The base message describing the error context.
 * @param context The relevant context (e.g., chat history, request contents).
 * @param type A string to identify the type of error (e.g., 'startChat', 'generateJson-api').
 */
export async function reportError(
  error: Error | unknown,
  baseMessage: string,
  context?: Content[] | Record<string, unknown> | unknown[],
  type = 'general',
  options?: ReportErrorOptions,
): Promise<void> {
  let errorToReport: { message: string; stack?: string };
  if (error instanceof Error) {
    errorToReport = { message: error.message, stack: error.stack };
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error
  ) {
    errorToReport = {
      message: String((error as { message: unknown }).message),
    };
  } else {
    errorToReport = { message: String(error) };
  }

  const reportContent: ErrorReportData = { error: errorToReport };

  if (context) {
    reportContent.contextSummary = options?.contextAlreadySummarized
      ? context
      : summarizeContext(context);
  }

  const reportLabel = `${baseMessage} [${type}]`;
  const stringifiedReportContent = JSON.stringify(reportContent, null, 2);

  // Write to debug log instead of separate file
  debugLogger.error(reportLabel, stringifiedReportContent);
}
