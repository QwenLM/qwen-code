/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Content } from '@google/genai';

/**
 * Defines the structure for the data that is written to an error report file.
 */
interface ErrorReportData {
  /**
   * The error object, containing the message and optionally the stack trace.
   */
  error: { message: string; stack?: string } | { message: string };
  /**
   * The context in which the error occurred (e.g., chat history, request contents).
   */
  context?: unknown;
  /**
   * Any additional information that might be useful for debugging.
   */
  additionalInfo?: Record<string, unknown>;
}

/**
 * Generates a detailed error report, writes it to a temporary file, and logs a summary to the console.
 * This function is designed to capture the state of the application when an unexpected error occurs,
 * making it easier to debug. The full report is saved as a JSON file in the system's temporary directory.
 *
 * @param error The error object that was thrown.
 * @param baseMessage A concise message to log to the console, providing immediate context about the error.
 * @param context The relevant data or state at the time of the error (e.g., chat history, request objects).
 * @param type A string to categorize the error, used in the report's filename (e.g., 'startChat', 'api-call').
 * @param reportingDir The directory where the error report file will be saved. Defaults to the system's temp directory.
 */
export async function reportError(
  error: Error | unknown,
  baseMessage: string,
  context?: Content[] | Record<string, unknown> | unknown[],
  type = 'general',
  reportingDir = os.tmpdir(), // for testing
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFileName = `gemini-client-error-${type}-${timestamp}.json`;
  const reportPath = path.join(reportingDir, reportFileName);

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

  let stringifiedReportContent: string;
  try {
    stringifiedReportContent = JSON.stringify(reportContent, null, 2);
  } catch (stringifyError) {
    // This can happen if context contains something like BigInt
    console.error(
      `${baseMessage} Could not stringify report content (likely due to context):`,
      stringifyError,
    );
    console.error('Original error that triggered report generation:', error);
    if (context) {
      console.error(
        'Original context could not be stringified or included in report.',
      );
    }
    // Fallback: try to report only the error if context was the issue
    try {
      const minimalReportContent = { error: errorToReport };
      stringifiedReportContent = JSON.stringify(minimalReportContent, null, 2);
      // Still try to write the minimal report
      await fs.writeFile(reportPath, stringifiedReportContent);
      console.error(
        `${baseMessage} Partial report (excluding context) available at: ${reportPath}`,
      );
    } catch (minimalWriteError) {
      console.error(
        `${baseMessage} Failed to write even a minimal error report:`,
        minimalWriteError,
      );
    }
    return;
  }

  try {
    await fs.writeFile(reportPath, stringifiedReportContent);
    console.error(`${baseMessage} Full report available at: ${reportPath}`);
  } catch (writeError) {
    console.error(
      `${baseMessage} Additionally, failed to write detailed error report:`,
      writeError,
    );
    // Log the original error as a fallback if report writing fails
    console.error('Original error that triggered report generation:', error);
    if (context) {
      // Context was stringifiable, but writing the file failed.
      // We already have stringifiedReportContent, but it might be too large for console.
      // So, we try to log the original context object, and if that fails, its stringified version (truncated).
      try {
        console.error('Original context:', context);
      } catch {
        try {
          console.error(
            'Original context (stringified, truncated):',
            JSON.stringify(context).substring(0, 1000),
          );
        } catch {
          console.error('Original context could not be logged or stringified.');
        }
      }
    }
  }
}
