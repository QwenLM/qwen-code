/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isRecord, readString } from '../config/model-values.js';

/** Replaces every occurrence of a secret with a redaction marker. */
export function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join('[REDACTED]') : value;
}

/**
 * Parses a provider error body as JSON, falling back to a truncated raw-body
 * message when the body is not valid JSON.
 */
function parseProviderErrorJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { message: body.slice(0, 500) || undefined };
  }
}

/**
 * Parses a provider HTTP error body into `{code, message}`, unwrapping the
 * conventional nested `error` envelope and truncating raw bodies.
 */
export function parseProviderErrorBody(body: string): {
  code?: string;
  message?: string;
} {
  const parsed = parseProviderErrorJson(body);
  const root = isRecord(parsed) ? parsed : undefined;
  const envelope = root && isRecord(root['error']) ? root['error'] : root;
  return {
    code: readString(envelope?.['code']),
    message:
      readString(envelope?.['message']) ??
      readString(root?.['message']) ??
      (body.slice(0, 500) || undefined),
  };
}
