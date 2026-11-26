/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { UnauthorizedError } from '@modelcontextprotocol/client';
import { isAuthenticationError } from '../utils/errors.js';
import { McpAuthorizationRequiredError } from './authorization.js';

/**
 * Finds an authorization failure even when it is wrapped. Era negotiation and
 * transport layers bury the original error under `cause` or `data.cause`, so
 * callers cannot rely on the top-level error being the typed one.
 */
export function findAuthRequiredError(
  error: unknown,
  seen: ReadonlySet<unknown> = new Set(),
): Error | undefined {
  if (error === null || typeof error !== 'object' || seen.has(error)) {
    return undefined;
  }
  const visited = new Set(seen).add(error);
  if (error instanceof McpAuthorizationRequiredError) return error;
  if (error instanceof UnauthorizedError || isAuthenticationError(error)) {
    return error as Error;
  }
  const fromCause = findAuthRequiredError(causeOf(error), visited);
  if (fromCause) return fromCause;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findAuthRequiredError(nested, visited);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Finds the typed authorization action even when a generic UnauthorizedError or
 * an SDK wrapper comes first, so the retry path cannot replace it with a plain
 * auth failure.
 */
export function findAuthorizationActionError(
  error: unknown,
  seen: ReadonlySet<unknown> = new Set(),
): McpAuthorizationRequiredError | undefined {
  if (error === null || typeof error !== 'object' || seen.has(error)) {
    return undefined;
  }
  const visited = new Set(seen).add(error);
  if (error instanceof McpAuthorizationRequiredError) return error;
  const fromCause = findAuthorizationActionError(causeOf(error), visited);
  if (fromCause) return fromCause;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findAuthorizationActionError(nested, visited);
      if (found) return found;
    }
  }
  return undefined;
}

/** The wrapped error of one level, for both Error.cause and SDK data.cause. */
export function causeOf(error: object): unknown {
  return (
    (error as { cause?: unknown }).cause ??
    (error as { data?: { cause?: unknown } }).data?.cause
  );
}
