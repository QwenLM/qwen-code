/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

export { RequestError } from '@agentclientprotocol/sdk';

// Local extension: authenticate/update is not part of the ACP spec.
// It is routed as an extension notification by our CLI.
export const EXT_CLIENT_METHODS = {
  authenticate_update: 'authenticate/update',
} as const;

// Re-export error codes in the shape that existing consumers expect.
// The numeric values match the SDK's ErrorCode type.
export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
} as const;

export type AcpErrorCode =
  (typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES];
