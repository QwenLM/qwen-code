/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseGoogleApiError, type ErrorInfo } from './googleErrors.js';
import { runLogger } from './runLogger.js';
import { UnauthorizedError as McpSdkUnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

interface GaxiosError {
  response?: {
    data?: unknown;
  };
}

function isGaxiosError(error: unknown): error is GaxiosError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response: unknown }).response === 'object' &&
    (error as { response: unknown }).response !== null
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** 仅路径确实缺失时允许降级，访问权限和临时 I/O 错误不能视为已删除。 */
export function isMissingPathError(error: unknown): boolean {
  return (
    isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

const FILE_ACCESS_DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Returns whether the operating system refused access to a filesystem path.
 *
 * Callers should only use this to degrade optional persistence. Required file
 * operations must continue to surface the original error.
 */
export function isFileAccessDeniedError(error: unknown): boolean {
  return isNodeError(error) && FILE_ACCESS_DENIED_CODES.has(error.code ?? '');
}

/**
 * Reports that optional persistence was skipped because access was denied.
 *
 * Shared so every degradation path logs the same shape; `details` carries the
 * scope-specific identifiers (agentId, taskId, ...).
 */
export function warnFileAccessDegraded(
  scope: string,
  operation: string,
  targetPath: string,
  error: unknown,
  ...details: string[]
): void {
  runLogger.warn(
    `[${scope}] persistence unavailable`,
    `operation=${operation}`,
    ...details,
    `path=${targetPath}`,
    error,
  );
}

/**
 * Checks if an error is an AbortError.
 * Shallow check: only matches Error instances by name.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Deep abort-error check: walks the cause chain and AggregateError.errors array,
 * and matches plain objects with name='AbortError' or code='ABORT_ERR'.
 * Use this for network-layer errors where AbortError may be wrapped in a cause
 * chain or an AggregateError (e.g. from fetch/undici).
 */
export function isAbortErrorDeep(
  error: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (typeof error !== 'object' || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);

  const e = error as Record<string, unknown>;
  if (e['name'] === 'AbortError' || e['code'] === 'ABORT_ERR') {
    return true;
  }

  if (isAbortErrorDeep(e['cause'], seen)) {
    return true;
  }

  const nestedErrors = e['errors'];
  return Array.isArray(nestedErrors)
    ? nestedErrors.some((nested) => isAbortErrorDeep(nested, seen))
    : false;
}

/**
 * Flattens an error and its nested `cause` chain plus any `AggregateError.errors`
 * into a de-duplicated list of Error instances. Cycle-safe via a `seen` set.
 * Use for network-layer errors where the underlying cause may be wrapped several
 * levels deep (e.g. from fetch/undici).
 */
export function collectErrorChain(error: unknown): Error[] {
  return collectErrorObjects(error).filter(
    (entry): entry is Error => entry instanceof Error,
  );
}

/** Flatten an error-like cause/AggregateError graph, including plain objects. */
export function collectErrorObjects(error: unknown): object[] {
  const result: object[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    result.push(current);

    const record = current as { cause?: unknown; errors?: unknown };
    if (record.cause !== undefined) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }

  return result;
}

/** Collect string messages from an error-like cause/AggregateError graph. */
export function collectErrorMessages(error: unknown): string[] {
  return collectErrorObjects(error)
    .map((entry) => (entry as Record<string, unknown>)['message'])
    .filter((message): message is string => typeof message === 'string');
}

/**
 * The innermost non-empty message of a cause/AggregateError graph, i.e. the
 * runtime's own explanation rather than the wrapper text a caller added on top.
 *
 * Callers that surface this to users are responsible for truncating it.
 */
export function readRootCauseMessage(error: unknown): string | undefined {
  const messages = collectErrorMessages(error);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i].trim();
    if (message) return message;
  }
  return undefined;
}

/**
 * Returns whether an error represents user/policy cancellation.
 *
 * Cancellation can surface as an AbortError, a wrapped AbortError, a
 * cancellation message from a host callback, or an already-aborted signal.
 * Callers that have an ordinary fallback path should use this helper before
 * swallowing an error so cancellation keeps propagating to the query owner.
 */
export function isCancellationError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted || isAbortErrorDeep(error)) {
    return true;
  }

  return collectErrorMessages(error).some((message) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('operation cancelled') ||
      normalized.includes('operation canceled') ||
      normalized.includes('cancelled by user') ||
      normalized.includes('canceled by user')
    );
  });
}

/** Collect string error codes from an error-like cause/AggregateError graph. */
export function collectErrorCodes(error: unknown): string[] {
  return collectErrorObjects(error)
    .map((entry) => (entry as Record<string, unknown>)['code'])
    .filter((code): code is string => typeof code === 'string');
}

/** Collect string error names and codes from a cause/AggregateError graph. */
export function collectErrorNamesAndCodes(error: unknown): string[] {
  return collectErrorObjects(error).flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    return [record['name'], record['code']].filter(
      (value): value is string => typeof value === 'string',
    );
  });
}

/**
 * Creates a standard AbortError for user-initiated cancellation.
 * Used by cancellation sites
 * to ensure consistent error name/message for downstream isAbortError() checks.
 */
export function createUserAbortError(cause?: unknown): Error {
  const error = new Error(
    'Operation cancelled by user',
    cause !== undefined ? { cause } : undefined,
  );
  error.name = 'AbortError';
  return error;
}

export function getErrorMessage(error: unknown): string {
  const friendlyError = toFriendlyError(error);
  if (friendlyError instanceof Error) {
    return friendlyError.message;
  }
  if (
    typeof friendlyError === 'object' &&
    friendlyError !== null &&
    'message' in friendlyError &&
    typeof (friendlyError as { message: unknown }).message === 'string'
  ) {
    return (friendlyError as { message: string }).message;
  }
  try {
    return String(friendlyError);
  } catch {
    return 'Failed to get error details';
  }
}

export function getErrorType(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';

  // Use the constructor name if the standard error name is missing or generic.
  const name =
    error.name && error.name !== 'Error'
      ? error.name
      : (error.constructor?.name ?? 'Error');

  // Strip leading underscore from error names. Bundlers like esbuild sometimes
  // rename classes to avoid scope collisions.
  return name.replace(/^_+/, '');
}

export class FatalError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'FatalError';
  }
}

export class FatalAuthenticationError extends FatalError {
  constructor(message: string) {
    super(message, 41);
    this.name = 'FatalAuthenticationError';
  }
}
export class FatalInputError extends FatalError {
  constructor(message: string) {
    super(message, 42);
    this.name = 'FatalInputError';
  }
}
export class FatalConfigError extends FatalError {
  constructor(message: string) {
    super(message, 52);
    this.name = 'FatalConfigError';
  }
}
export class FatalTurnLimitedError extends FatalError {
  constructor(message: string) {
    super(message, 53);
    this.name = 'FatalTurnLimitedError';
  }
}
export class FatalToolExecutionError extends FatalError {
  constructor(message: string) {
    super(message, 54);
    this.name = 'FatalToolExecutionError';
  }
}
export class FatalCancellationError extends FatalError {
  constructor(message: string) {
    super(message, 130); // Standard exit code for SIGINT
    this.name = 'FatalCancellationError';
  }
}

export class CanceledError extends Error {
  constructor(message = 'The operation was canceled.') {
    super(message);
    this.name = 'CanceledError';
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}
export class AccountSuspendedError extends ForbiddenError {
  readonly appealUrl?: string;
  readonly appealLinkText?: string;

  constructor(message: string, metadata?: Record<string, string>) {
    super(message);
    this.name = 'AccountSuspendedError';
    this.appealUrl = metadata?.['appeal_url'];
    this.appealLinkText = metadata?.['appeal_url_link_text'];
  }
}
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class ChangeAuthRequestedError extends Error {
  constructor() {
    super('User requested to change authentication method');
    this.name = 'ChangeAuthRequestedError';
  }
}

interface ResponseData {
  error?: {
    code?: number;
    message?: string;
  };
}

function isResponseData(data: unknown): data is ResponseData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as ResponseData;
  if (!('error' in candidate)) {
    return false;
  }
  const error = candidate.error;
  if (typeof error !== 'object' || error === null) {
    return false; // error property exists but is not an object (could be undefined, but we checked 'in')
  }

  // Optional properties check
  if (
    'code' in error &&
    typeof error.code !== 'number' &&
    error.code !== undefined
  ) {
    return false;
  }
  if (
    'message' in error &&
    typeof error.message !== 'string' &&
    error.message !== undefined
  ) {
    return false;
  }

  return true;
}

export function toFriendlyError(error: unknown): unknown {
  // First, try structured parsing for TOS_VIOLATION detection.
  const googleApiError = parseGoogleApiError(error);
  if (googleApiError && googleApiError.code === 403) {
    const tosDetail = googleApiError.details.find(
      (d): d is ErrorInfo =>
        d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        'reason' in d &&
        d.reason === 'TOS_VIOLATION',
    );
    if (tosDetail) {
      return new AccountSuspendedError(
        googleApiError.message,
        tosDetail.metadata,
      );
    }
  }

  // Fall back to basic Gaxios error parsing for other HTTP errors.
  if (isGaxiosError(error)) {
    const data = parseResponseData(error);
    if (data && data.error && data.error.message && data.error.code) {
      switch (data.error.code) {
        case 400:
          return new BadRequestError(data.error.message);
        case 401:
          return new UnauthorizedError(data.error.message);
        case 403:
          return new ForbiddenError(data.error.message);
        default:
      }
    }
  }
  return error;
}

export function isAccountSuspendedError(
  error: unknown,
): AccountSuspendedError | null {
  const friendly = toFriendlyError(error);
  return friendly instanceof AccountSuspendedError ? friendly : null;
}

function parseResponseData(error: GaxiosError): ResponseData | undefined {
  let data = error.response?.data;
  // Inexplicably, Gaxios sometimes doesn't JSONify the response data.
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  if (isResponseData(data)) {
    return data;
  }
  return undefined;
}

/**
 * Checks if an error is a 401 authentication error.
 * Uses structured error properties from MCP SDK errors.
 *
 * @param error The error to check
 * @returns true if this is a 401/authentication error
 */
export function isAuthenticationError(error: unknown): boolean {
  // Use the SDK class identity instead of its constructor name. Production
  // builds minify class identifiers, so `UnauthorizedError` may become an
  // arbitrary short name while the prototype relationship remains intact.
  if (error instanceof McpSdkUnauthorizedError) {
    return true;
  }

  // Check for MCP SDK errors with code property
  // (SseError and StreamableHTTPError both have numeric 'code' property)
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'number'
  ) {
    // Safe access after check
    const errorCode = (error as { code: number }).code;
    if (errorCode === 401) {
      return true;
    }
  }

  // Keep name matching as a compatibility fallback for environments that load
  // separate ESM/CJS copies of the SDK class. This is not the primary check
  // because constructor names are not stable after minification.
  if (
    error instanceof Error &&
    (error.name === 'UnauthorizedError' ||
      error.constructor.name === 'UnauthorizedError')
  ) {
    return true;
  }

  if (error instanceof UnauthorizedError) {
    return true;
  }

  // Fallback: Check for MCP SDK's plain Error messages with HTTP 401
  // The SDK sometimes throws: new Error(`Error POSTing to endpoint (HTTP 401): ...`)
  const message = getErrorMessage(error);
  if (message.includes('401')) {
    return true;
  }

  return false;
}
