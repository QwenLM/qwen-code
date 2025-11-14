/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  OutputFormat,
  JsonFormatter,
  parseAndFormatApiError,
  FatalTurnLimitedError,
  FatalCancellationError,
} from '@qwen-code/qwen-code-core';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface ErrorWithCode extends Error {
  exitCode?: number;
  code?: string | number;
  status?: string | number;
}

/**
 * Extracts the appropriate error code from an error object.
 */
function extractErrorCode(error: unknown): string | number {
  const errorWithCode = error as ErrorWithCode;

  // Prioritize exitCode for FatalError types, fall back to other codes
  if (typeof errorWithCode.exitCode === 'number') {
    return errorWithCode.exitCode;
  }
  if (errorWithCode.code !== undefined) {
    return errorWithCode.code;
  }
  if (errorWithCode.status !== undefined) {
    return errorWithCode.status;
  }

  return 1; // Default exit code
}

/**
 * Converts an error code to a numeric exit code.
 */
function getNumericExitCode(errorCode: string | number): number {
  return typeof errorCode === 'number' ? errorCode : 1;
}

/**
 * Handles errors consistently for both JSON and text output formats.
 * In JSON mode, outputs formatted JSON error and exits.
 * In text mode, outputs error message and re-throws.
 */
export function handleError(
  error: unknown,
  config: Config,
  customErrorCode?: string | number,
): never {
  const errorMessage = parseAndFormatApiError(
    error,
    config.getContentGeneratorConfig()?.authType,
  );

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const errorCode = customErrorCode ?? extractErrorCode(error);

    const formattedError = formatter.formatError(
      error instanceof Error ? error : new Error(getErrorMessage(error)),
      errorCode,
    );

    console.error(formattedError);
    process.exit(getNumericExitCode(errorCode));
  } else {
    console.error(errorMessage);
    throw error;
  }
}

/**
 * Handles tool execution errors specifically.
 * In JSON/STREAM_JSON mode, outputs error message to stderr only and does not exit.
 * The error will be properly formatted in the tool_result block by the adapter,
 * allowing the session to continue so the LLM can decide what to do next.
 * In text mode, outputs error message to stderr only.
 *
 * @param toolName - Name of the tool that failed
 * @param toolError - The error that occurred during tool execution
 * @param config - Configuration object
 * @param errorCode - Optional error code
 * @param resultDisplay - Optional display message for the error
 */
export function handleToolError(
  toolName: string,
  toolError: Error,
  config: Config,
  _errorCode?: string | number,
  resultDisplay?: string,
): void {
  // Always just log to stderr; JSON/streaming formatting happens in the tool_result block elsewhere
  if (config.getDebugMode()) {
    console.error(
      `Error executing tool ${toolName}: ${resultDisplay || toolError.message}`,
    );
  }
}

/**
 * Handles cancellation/abort signals consistently.
 */
export function handleCancellationError(config: Config): never {
  const cancellationError = new FatalCancellationError('Operation cancelled.');

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      cancellationError,
      cancellationError.exitCode,
    );

    console.error(formattedError);
    process.exit(cancellationError.exitCode);
  } else {
    console.error(cancellationError.message);
    process.exit(cancellationError.exitCode);
  }
}

/**
 * Handles max session turns exceeded consistently.
 */
export function handleMaxTurnsExceededError(config: Config): never {
  const maxTurnsError = new FatalTurnLimitedError(
    'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
  );

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      maxTurnsError,
      maxTurnsError.exitCode,
    );

    console.error(formattedError);
    process.exit(maxTurnsError.exitCode);
  } else {
    console.error(maxTurnsError.message);
    process.exit(maxTurnsError.exitCode);
  }
}
