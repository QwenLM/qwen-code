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
  context?: unknown;
  additionalInfo?: Record<string, unknown>;
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
    reportContent.context = context;
  }

  const reportLabel = `${baseMessage} [${type}]`;
  let stringifiedReportContent: string;
  try {
    stringifiedReportContent = JSON.stringify(reportContent, null, 2);
  } catch (stringifyError) {
    // This can happen if context contains something like BigInt
    debugLogger.error(
      `${reportLabel} Could not stringify report content (likely due to context):`,
      stringifyError,
      error,
    );
    // Fallback: try to report only the error if context was the issue
    try {
      const minimalReportContent = { error: errorToReport };
      stringifiedReportContent = JSON.stringify(minimalReportContent, null, 2);
      debugLogger.error(reportLabel, stringifiedReportContent);
    } catch (minimalStringifyError) {
      debugLogger.error(
        `${reportLabel} Failed to stringify minimal error report:`,
        minimalStringifyError,
        error,
      );
    }
    return;
  }

  // Write to debug log instead of separate file
  debugLogger.error(reportLabel, stringifiedReportContent);
}
