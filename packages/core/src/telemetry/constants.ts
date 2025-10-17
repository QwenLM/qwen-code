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
export const EVENT_API_CANCEL = 'qwen-code.api_cancel';
export const EVENT_API_RESPONSE = 'qwen-code.api_response';
export const EVENT_CLI_CONFIG = 'qwen-code.config';
export const EVENT_FLASH_FALLBACK = 'qwen-code.flash_fallback';
export const EVENT_NEXT_SPEAKER_CHECK = 'qwen-code.next_speaker_check';
export const EVENT_SLASH_COMMAND = 'qwen-code.slash_command';
export const EVENT_IDE_CONNECTION = 'qwen-code.ide_connection';
export const EVENT_CHAT_COMPRESSION = 'qwen-code.chat_compression';
export const EVENT_INVALID_CHUNK = 'qwen-code.chat.invalid_chunk';
export const EVENT_CONTENT_RETRY = 'qwen-code.chat.content_retry';
export const EVENT_CONTENT_RETRY_FAILURE =
  'qwen-code.chat.content_retry_failure';
export const EVENT_CONVERSATION_FINISHED = 'qwen-code.conversation_finished';
export const EVENT_MALFORMED_JSON_RESPONSE =
  'qwen-code.malformed_json_response';
export const EVENT_SUBAGENT_EXECUTION = 'qwen-code.subagent_execution';

export const METRIC_TOOL_CALL_COUNT = 'qwen-code.tool.call.count';
export const METRIC_TOOL_CALL_LATENCY = 'qwen-code.tool.call.latency';
export const METRIC_API_REQUEST_COUNT = 'qwen-code.api.request.count';
export const METRIC_API_REQUEST_LATENCY = 'qwen-code.api.request.latency';
export const METRIC_TOKEN_USAGE = 'qwen-code.token.usage';
export const METRIC_SESSION_COUNT = 'qwen-code.session.count';
export const METRIC_FILE_OPERATION_COUNT = 'qwen-code.file.operation.count';
export const METRIC_INVALID_CHUNK_COUNT = 'qwen-code.chat.invalid_chunk.count';
export const METRIC_CONTENT_RETRY_COUNT = 'qwen-code.chat.content_retry.count';
export const METRIC_CONTENT_RETRY_FAILURE_COUNT =
  'qwen-code.chat.content_retry_failure.count';
export const METRIC_SUBAGENT_EXECUTION_COUNT =
  'qwen-code.subagent.execution.count';
