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
export const EVENT_EXTENSION_DISABLE = 'qwen-code.extension_disable';
export const EVENT_EXTENSION_ENABLE = 'qwen-code.extension_enable';
export const EVENT_EXTENSION_INSTALL = 'qwen-code.extension_install';
export const EVENT_EXTENSION_UNINSTALL = 'qwen-code.extension_uninstall';
export const EVENT_FLASH_FALLBACK = 'qwen-code.flash_fallback';
export const EVENT_RIPGREP_FALLBACK = 'qwen-code.ripgrep_fallback';
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
export const EVENT_FILE_OPERATION = 'qwen-code.file_operation';
export const EVENT_MODEL_SLASH_COMMAND = 'qwen-code.slash_command.model';
export const EVENT_SUBAGENT_EXECUTION = 'qwen-code.subagent_execution';
export const EVENT_AUTH = 'qwen-code.auth';

// Performance Events
export const EVENT_STARTUP_PERFORMANCE = 'qwen-code.startup.performance';
export const EVENT_MEMORY_USAGE = 'qwen-code.memory.usage';
export const EVENT_PERFORMANCE_BASELINE = 'qwen-code.performance.baseline';
export const EVENT_PERFORMANCE_REGRESSION = 'qwen-code.performance.regression';
