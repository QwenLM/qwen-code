/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

import { parseBoolean } from '../config-service/features/gateParseUtils.js';

export const MALFORMED_TOOL_USE_CODE = 'MALFORMED_TOOL_USE';
export const MALFORMED_TOOL_USE_EXHAUSTED_CODE = 'MALFORMED_TOOL_USE_EXHAUSTED';
export const MALFORMED_TOOL_USE_RETRY_PROMPT =
  'Your tool call was malformed and could not be parsed. Please retry.';
export const MALFORMED_TOOL_USE_RETRY_DISABLE_ENV = `${BRAND_FIXED_ENV_PREFIX}DISABLE_MALFORMED_TOOL_USE_RETRY`;

export class MalformedToolUseError extends Error {
  readonly code = MALFORMED_TOOL_USE_CODE;
  readonly error_code = MALFORMED_TOOL_USE_CODE;
  readonly retryable = false;

  constructor() {
    super("The model's tool call could not be parsed.");
    this.name = 'MalformedToolUseError';
  }
}

export class MalformedToolUseExhaustedError extends Error {
  readonly code = MALFORMED_TOOL_USE_EXHAUSTED_CODE;
  readonly error_code = MALFORMED_TOOL_USE_EXHAUSTED_CODE;
  readonly retryable = false;

  constructor() {
    super("The model's tool call could not be parsed (retry also failed).");
    this.name = 'MalformedToolUseExhaustedError';
  }
}

export function isMalformedToolUseRetryDisabled(): boolean {
  return (
    parseBoolean(process.env[MALFORMED_TOOL_USE_RETRY_DISABLE_ENV]) ?? false
  );
}
