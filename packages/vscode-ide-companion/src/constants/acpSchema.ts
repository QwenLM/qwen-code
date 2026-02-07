/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const AGENT_METHODS = {
  authenticate: 'authenticate',
  initialize: 'initialize',
  session_cancel: 'session/cancel',
  session_list: 'session/list',
  session_load: 'session/load',
  session_new: 'session/new',
  session_prompt: 'session/prompt',
  session_save: 'session/save',
  session_set_mode: 'session/set_mode',
  session_set_model: 'session/set_model',
} as const;

export const CLIENT_METHODS = {
  fs_read_text_file: 'fs/read_text_file',
  fs_write_text_file: 'fs/write_text_file',
  authenticate_update: 'authenticate/update',
  session_request_permission: 'session/request_permission',
  session_update: 'session/update',
} as const;

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
