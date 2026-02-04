/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const ACP_ERROR_CODES = {
  // Parse error: invalid JSON received by server.
  PARSE_ERROR: -32700,
  // Invalid request: JSON is not a valid Request object.
  INVALID_REQUEST: -32600,
  // Method not found: method does not exist or is unavailable.
  METHOD_NOT_FOUND: -32601,
  // Invalid params: invalid method parameter(s).
  INVALID_PARAMS: -32602,
  // Internal error: implementation-defined server error.
  INTERNAL_ERROR: -32603,
  // Authentication required: must authenticate before operation.
  AUTH_REQUIRED: -32000,
  // Resource not found: e.g. missing file.
  RESOURCE_NOT_FOUND: -32002,
} as const;

export type AcpErrorCode =
  (typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES];
