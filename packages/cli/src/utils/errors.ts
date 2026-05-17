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
  ToolErrorType,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { runExitCleanup } from './cleanup.js';
import { writeStderrLine } from './stdioHelpers.js';

const debugLogger = createDebugLogger('CLI_ERRORS');

/**
 * Marker thrown when a producer has already formatted the error message and
 * written it to stderr — the downstream `handleError` should propagate the
 * exit code without printing or reformatting again.
 *
 * The non-interactive runner uses this when an upstream API error event
 * arrives mid-stream: it formats with parseAndFormatApiError, writes once,
 * and then throws. Without this marker, handleError would call
 * parseAndFormatApiError a second time on the (now formatted) Error.message,
 * yielding "[API Error: [API Error: ...]]" plus a duplicate stderr line.
 */
export class AlreadyReportedError extends Error {
  /** Exit code to surface — defaults to 1 for generic upstream failures. */
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'AlreadyReportedError';
    this.exitCode = exitCode;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  // Handle objects with message property (error-like objects)
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  // Handle plain objects by stringifying them
  if (error !== null && typeof error === 'object') {
    try {
      const stringified = JSON.stringify(error);
      // JSON.stringify can return undefined for objects with toJSON() returning undefined
      return stringified ?? String(error);
    } catch {
      // If JSON.stringify fails (circular reference, etc.), fall back to String
      return String(error);
    }
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
 * Drains pending cleanup before terminating. Routing every "we're about
 * to die" path through here keeps async exit-side I/O (chat-recording
 * flush, telemetry shutdown, MCP disconnect) from being skipped — the
 * earlier sync writes were inherently bounded so a bare `process.exit`
 * was safe; with the async-jsonl change it is not.
 */
// Guards against double-entry when two terminating paths race (e.g. SIGINT
// fires `handleCancellationError` while a stream rejection routes through
// `handleError`): only the first caller drains cleanup + exits; the second
// suspends forever in the unresolved promise and gets killed when the first
// caller's process.exit fires.
let exiting = false;

async function exitAfterCleanup(code: number): Promise<never> {
  if (exiting) return new Promise<never>(() => {});
  exiting = true;
  await runExitCleanup();
  // `return` so process.exit's `never` narrows the function's terminating
  // statement — without it TS reports "function returning 'never' cannot
  // have a reachable end point" because await doesn't propagate `never`.
  return process.exit(code);
}

/** Test-only — reset the exit-once latch between cases. */
export function _resetExitLatchForTest(): void {
  exiting = false;
}

/**
 * Handles errors consistently for both JSON and text output formats.
 * In JSON mode, outputs formatted JSON error and exits.
 * In text mode, outputs error message and re-throws.
 */
export async function handleError(
  error: unknown,
  config: Config,
  customErrorCode?: string | number,
): Promise<never> {
  // Producers that already wrote a formatted message to stderr (see
  // AlreadyReportedError above) should not be reprinted or reformatted here.
  // In TEXT mode this short-circuits straight to a clean re-throw; in JSON
  // mode we still emit the structured payload exactly once so machine
  // consumers don't lose the error.
  if (error instanceof AlreadyReportedError) {
    if (config.getOutputFormat() === OutputFormat.JSON) {
      const formatter = new JsonFormatter();
      const errorCode = customErrorCode ?? error.exitCode;
      const formattedError = formatter.formatError(error, errorCode);
      writeStderrLine(formattedError);
      return exitAfterCleanup(getNumericExitCode(errorCode));
    }
    await runExitCleanup();
    throw error;
  }

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

    writeStderrLine(formattedError);
    return exitAfterCleanup(getNumericExitCode(errorCode));
  } else {
    writeStderrLine(errorMessage);
    // Drain queued writes before re-throwing so the unhandled rejection
    // path doesn't lose chat-recording records that are still in the queue.
    await runExitCleanup();
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
  errorCode?: string | number,
  resultDisplay?: string,
): void {
  // Check if this is a permission denied error in non-interactive mode
  const isExecutionDenied = errorCode === ToolErrorType.EXECUTION_DENIED;
  const isNonInteractive = !config.isInteractive();
  const isTextMode = config.getOutputFormat() === OutputFormat.TEXT;

  // Show warning for permission denied errors in non-interactive text mode
  if (isExecutionDenied && isNonInteractive && isTextMode) {
    const warningMessage =
      `Warning: Tool "${toolName}" requires user approval but cannot execute in non-interactive mode.\n` +
      `To enable automatic tool execution, use the -y flag (YOLO mode):\n` +
      `Example: qwen -p 'your prompt' -y\n\n`;
    process.stderr.write(warningMessage);
  }

  debugLogger.error(
    `Error executing tool ${toolName}: ${resultDisplay || toolError.message}`,
  );
}

/**
 * Handles cancellation/abort signals consistently.
 */
export async function handleCancellationError(config: Config): Promise<never> {
  const cancellationError = new FatalCancellationError('Operation cancelled.');

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      cancellationError,
      cancellationError.exitCode,
    );

    writeStderrLine(formattedError);
  } else {
    writeStderrLine(cancellationError.message);
  }
  return exitAfterCleanup(cancellationError.exitCode);
}

/**
 * Handles max session turns exceeded consistently.
 *
 * When `--json-schema` is active the error gets an extra hint pointing at the
 * common reasons a structured-output run never terminated: the model never
 * called `structured_output`, the tool was denied by `permissions.deny` /
 * `--exclude-tools`, or the schema is unsatisfiable. Without this, all three
 * failure modes surface as the same generic "increase maxSessionTurns" line
 * even though the fix is a permissions / schema change, not a turns bump.
 */
export async function handleMaxTurnsExceededError(
  config: Config,
): Promise<never> {
  const baseMessage =
    'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.';
  const jsonSchemaActive = config.getJsonSchema?.() !== undefined;
  const message = jsonSchemaActive
    ? `${baseMessage}\nNote: --json-schema is active. If the model never called structured_output, verify it isn't denied by permissions.deny / --exclude-tools and that the schema is satisfiable.`
    : baseMessage;
  const maxTurnsError = new FatalTurnLimitedError(message);

  if (config.getOutputFormat() === OutputFormat.JSON) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      maxTurnsError,
      maxTurnsError.exitCode,
    );

    writeStderrLine(formattedError);
  } else {
    writeStderrLine(maxTurnsError.message);
  }
  return exitAfterCleanup(maxTurnsError.exitCode);
}
