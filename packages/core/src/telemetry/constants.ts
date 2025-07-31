/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const SERVICE_NAME = 'qwen-code';

export const EVENT_USER_PROMPT = 'qwen-code.user_prompt';
export const EVENT_TOOL_CALL = 'qwen-code.tool_call';
export const EVENT_API_REQUEST = 'qwen-code.api_request';
export const EVENT_API_ERROR = 'qwen-code.api_error';
export const EVENT_API_RESPONSE = 'qwen-code.api_response';
export const EVENT_CLI_CONFIG = 'qwen-code.config';
export const EVENT_FLASH_FALLBACK = 'qwen-code.flash_fallback';

export const METRIC_TOOL_CALL_COUNT = 'qwen-code.tool.call.count';
export const METRIC_TOOL_CALL_LATENCY = 'qwen-code.tool.call.latency';
export const METRIC_API_REQUEST_COUNT = 'qwen-code.api.request.count';
export const METRIC_API_REQUEST_LATENCY = 'qwen-code.api.request.latency';
export const METRIC_TOKEN_USAGE = 'qwen-code.token.usage';
export const METRIC_SESSION_COUNT = 'qwen-code.session.count';
export const METRIC_FILE_OPERATION_COUNT = 'qwen-code.file.operation.count';
