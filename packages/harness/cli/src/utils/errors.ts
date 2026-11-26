/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ResultErrorCode,
  SDKResultError,
} from '@qwen-code/core';
import {
  OutputFormat,
  parseAndFormatApiError,
  FatalCancellationError,
  runLogger,
  coreEvents,
  cloneUsage,
  getResultErrorCode,
  findModelInferenceError,
  getServerErrorMessage,
  getResultErrorCodeFromMessages,
  ndjsonSafeStringify,
  sessionLogger,
  ExitCodes,
  getExecutionEnvironmentError,
} from '@qwen-code/core';
import { randomUUID } from 'node:crypto';
import { runSyncCleanup } from './cleanup.js';

interface ErrorWithCode extends Error {
  exitCode?: number;
  code?: string | number;
  status?: string | number;
}

function isJsonLikeOutput(outputFormat: OutputFormat): boolean {
  return (
    outputFormat === OutputFormat.STREAM_JSON ||
    outputFormat === OutputFormat.JSON
  );
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

type SdkErrorSubtype =
  | 'error_during_execution'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries';

const STRUCTURED_AUTH_ERROR_CODES = new Set([
  'auth_payload_invalid',
  'access_token_invalid',
  'auth_required',
  'auth_expired',
  'job_token_invalid',
  'job_token_unavailable',
  'job_token_cancelled',
  'service_account_key_invalid',
  'service_account_key_unavailable',
  'service_account_scope_insufficient',
  'service_account_token_cancelled',
  'service_account_token_expired',
  'service_account_token_invalid',
  'service_account_token_not_yet_valid',
  'service_account_token_principal_changed',
  'service_account_token_scope_insufficient',
  'service_account_token_unavailable',
]);

interface ResultErrorOutputOptions {
  errors: string[];
  exitCode: string | number;
  errorCode?: ResultErrorCode;
  error?: unknown;
  subtype?: SdkErrorSubtype;
  terminalReason?: string;
}

function normalizeResultErrorMessage(message: string): string {
  if (message.startsWith('[') && message.endsWith(']')) {
    return message.slice(1, -1);
  }
  return message;
}

export function formatResultErrorMessage(
  error: unknown,
  authType?: ReturnType<Config['getContentGeneratorConfig']>['authType'],
): string {
  if (getStructuredAuthErrorCode(error) === 'job_token_invalid') {
    return formatAuthenticationErrorMessage(error);
  }
  return normalizeResultErrorMessage(parseAndFormatApiError(error, authType));
}

export function formatAuthenticationErrorMessage(error: unknown): string {
  return getStructuredAuthErrorCode(error) === 'job_token_invalid'
    ? 'Unable to verify your sign-in status. Sign in again and try again.'
    : error instanceof Error
      ? error.message
      : String(error);
}

export function getStructuredAuthErrorCode(error: unknown): string | undefined {
  const rawCode =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof rawCode === 'string' && STRUCTURED_AUTH_ERROR_CODES.has(rawCode)) {
    return rawCode;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  const prefixedCode = /^([a-z][a-z0-9_]*):/.exec(message)?.[1];
  return prefixedCode && STRUCTURED_AUTH_ERROR_CODES.has(prefixedCode)
    ? prefixedCode
    : undefined;
}

function stripStructuredErrorPrefix(message: string, code?: string): string {
  if (!code) return message;
  const prefix = `${code}:`;
  return message.startsWith(prefix)
    ? message.slice(prefix.length).trim()
    : message;
}

export function buildErrorResultMessage(
  sessionId: string,
  options: Omit<ResultErrorOutputOptions, 'exitCode'>,
): SDKResultError {
  const providerError = findModelInferenceError(options.error);
  const resultErrorCode = providerError
    ? providerError.code
    : (options.errorCode ?? getResultErrorCodeFromMessages(options.errors));
  const errorMessage = getServerErrorMessage(options.error);
  return {
    ...(errorMessage !== undefined ? { error_message: errorMessage } : {}),
    type: 'result',
    subtype: options.subtype ?? 'error_during_execution',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    total_credits: 0,
    usage: cloneUsage(),
    modelUsage: {},
    permission_denials: [],
    errors: options.errors,
    ...(resultErrorCode !== undefined ? { error_code: resultErrorCode } : {}),
    terminal_reason: options.terminalReason,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

export function emitResultErrorOutputWithSession(
  sessionId: string,
  options: ResultErrorOutputOptions,
): never {
  const message = buildErrorResultMessage(sessionId, options);
  process.stdout.write(ndjsonSafeStringify(message) + '\n');
  runSyncCleanup();
  sessionLogger.setExitContext({
    reason: 'fatal_error',
    exit_code: getNumericExitCode(options.exitCode),
    message: options.errors.join('; '),
    source: 'errors.emitResultErrorOutput',
  });
  process.exit(getNumericExitCode(options.exitCode));
}

export function emitResultErrorOutput(
  config: Config,
  options: ResultErrorOutputOptions,
): never {
  return emitResultErrorOutputWithSession(config.getSessionId(), options);
}

export function handleErrorWithOutput(
  error: unknown,
  outputFormat: OutputFormat,
  sessionId: string,
  customErrorCode?: string | number,
  authType?: ReturnType<Config['getContentGeneratorConfig']>['authType'],
): never {
  if (getExecutionEnvironmentError(error)) {
    runLogger.error('Execution environment operation failed', error);
  }
  const errorMessage = formatResultErrorMessage(error, authType);

  if (isJsonLikeOutput(outputFormat)) {
    const errorCode = customErrorCode ?? extractErrorCode(error);
    const structuredCode = getStructuredAuthErrorCode(error);
    emitResultErrorOutputWithSession(sessionId, {
      errors: [stripStructuredErrorPrefix(errorMessage, structuredCode)],
      exitCode:
        structuredCode !== undefined
          ? ExitCodes.FATAL_AUTHENTICATION_ERROR
          : errorCode,
      errorCode: getResultErrorCode(error),
      error,
      terminalReason: structuredCode ? 'completed' : undefined,
    });
  } else {
    throw error;
  }
}

/**
 * Handles errors consistently for both JSON and text output formats.
 * In JSON and streaming JSON modes, emits an SDK result error event.
 * In text mode, outputs error message and re-throws.
 */
export function handleError(
  error: unknown,
  config: Config,
  customErrorCode?: string | number,
): never {
  return handleErrorWithOutput(
    error,
    config.getOutputFormat(),
    config.getSessionId(),
    customErrorCode,
    config.getContentGeneratorConfig()?.authType,
  );
}

/**
 * Handles cancellation/abort signals consistently.
 */
export function handleCancellationError(config: Config): never {
  const cancellationError = new FatalCancellationError('Operation cancelled.');

  if (isJsonLikeOutput(config.getOutputFormat())) {
    emitResultErrorOutput(config, {
      errors: [cancellationError.message],
      exitCode: cancellationError.exitCode,
    });
  } else {
    coreEvents.emitFeedback('error', cancellationError.message);
    runSyncCleanup();
    sessionLogger.setExitContext({
      reason: 'cancelled',
      exit_code: cancellationError.exitCode,
      message: cancellationError.message,
      source: 'errors.handleCancellationError',
      error_name: cancellationError.name,
      error_stack: cancellationError.stack,
    });
    process.exit(cancellationError.exitCode);
  }
}
