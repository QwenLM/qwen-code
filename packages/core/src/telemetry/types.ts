/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { Config } from '../config/config.js';
import type { ApprovalMode } from '../config/config.js';
import type { CompletedToolCall } from '../core/coreToolScheduler.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import type { FileDiff } from '../tools/tools.js';
import type { AuthType } from '../core/contentGenerator.js';
import {
  getDecisionFromOutcome,
  ToolCallDecision,
} from './tool-call-decision.js';
import type { FileOperation } from './metrics.js';
export { ToolCallDecision };
import type { OutputFormat } from '../output/types.js';
import { ToolNames } from '../tools/tool-names.js';
import { STRUCTURED_OUTPUT_REDACTED_ARGS } from '../tools/syntheticOutput.js';
import type { SkillTool } from '../tools/skill.js';
import type { AgentTool } from '../tools/agent/agent.js';

export interface BaseTelemetryEvent {
  'event.name': string;
  /** Current timestamp in ISO 8601 format */
  'event.timestamp': string;
}

type CommonFields = keyof BaseTelemetryEvent;

export class StartSessionEvent implements BaseTelemetryEvent {
  'event.name': 'cli_config';
  'event.timestamp': string;
  session_id: string;
  model: string;
  sandbox_enabled: boolean;
  core_tools_enabled?: string;
  approval_mode: string;
  debug_enabled: boolean;
  truncate_tool_output_threshold: number;
  truncate_tool_output_lines: number;
  mcp_servers: string;
  telemetry_enabled: boolean;
  file_filtering_respect_git_ignore: boolean;
  mcp_servers_count: number;
  mcp_tools_count?: number;
  mcp_tools?: string;
  output_format: OutputFormat;
  hooks?: string;
  ide_enabled: boolean;
  interactive_shell_enabled: boolean;
  skills?: string;
  subagents?: string;

  constructor(config: Config) {
    const mcpServers = config.getMcpServers();
    const toolRegistry = config.getToolRegistry();

    this['event.name'] = 'cli_config';
    this.session_id = config.getSessionId();
    this.model = config.getModel();
    this.sandbox_enabled =
      typeof config.getSandbox() === 'string' || !!config.getSandbox();
    this.core_tools_enabled = (
      config.getPermissionManager?.()?.getAllowRawStrings() ??
      config.getCoreTools() ??
      []
    ).join(',');
    this.approval_mode = config.getApprovalMode();
    this.debug_enabled = config.getDebugMode();
    this.truncate_tool_output_threshold =
      config.getTruncateToolOutputThreshold();
    this.truncate_tool_output_lines = config.getTruncateToolOutputLines();
    this.mcp_servers = mcpServers ? Object.keys(mcpServers).join(',') : '';
    this.telemetry_enabled = config.getTelemetryEnabled();
    this.file_filtering_respect_git_ignore =
      config.getFileFilteringRespectGitIgnore();
    this.mcp_servers_count = mcpServers ? Object.keys(mcpServers).length : 0;
    this.output_format = config.getOutputFormat();
    this.ide_enabled = config.getIdeMode();
    this.interactive_shell_enabled = config.getShouldUseNodePtyShell();

    const hookSystem = config.getHookSystem();
    if (hookSystem) {
      const allHooks = hookSystem.getAllHooks();
      const uniqueEventNames = [...new Set(allHooks.map((h) => h.eventName))];
      if (uniqueEventNames.length > 0) {
        this.hooks = uniqueEventNames.join(',');
      }
    }

    if (toolRegistry) {
      const mcpTools = toolRegistry
        .getAllTools()
        .filter((tool) => tool instanceof DiscoveredMCPTool);
      this.mcp_tools_count = mcpTools.length;
      this.mcp_tools = mcpTools
        .map((tool) => (tool as DiscoveredMCPTool).name)
        .join(',');

      const skillTool = toolRegistry.getTool(ToolNames.SKILL) as
        | SkillTool
        | undefined;
      const skillNames = skillTool?.getAvailableSkillNames?.();
      if (skillNames && skillNames.length > 0) {
        this.skills = skillNames.join(',');
      }

      const agentTool = toolRegistry.getTool(ToolNames.AGENT) as
        | AgentTool
        | undefined;
      const subagentNames = agentTool?.getAvailableSubagentNames?.();
      if (subagentNames && subagentNames.length > 0) {
        this.subagents = subagentNames.join(',');
      }
    }
  }
}

export class EndSessionEvent implements BaseTelemetryEvent {
  'event.name': 'end_session';
  'event.timestamp': string;
  session_id?: string;

  constructor(config?: Config) {
    this['event.name'] = 'end_session';
    this['event.timestamp'] = new Date().toISOString();
    this.session_id = config?.getSessionId();
  }
}

export class UserPromptEvent implements BaseTelemetryEvent {
  'event.name': 'user_prompt';
  'event.timestamp': string;
  prompt_length: number;
  prompt_id: string;
  auth_type?: string;
  prompt?: string;

  constructor(
    prompt_length: number,
    prompt_Id: string,
    auth_type?: string,
    prompt?: string,
  ) {
    this['event.name'] = 'user_prompt';
    this['event.timestamp'] = new Date().toISOString();
    this.prompt_length = prompt_length;
    this.prompt_id = prompt_Id;
    this.auth_type = auth_type;
    this.prompt = prompt;
  }
}

export class UserRetryEvent implements BaseTelemetryEvent {
  'event.name': 'user_retry';
  'event.timestamp': string;
  prompt_id: string;

  constructor(prompt_id: string) {
    this['event.name'] = 'user_retry';
    this['event.timestamp'] = new Date().toISOString();
    this.prompt_id = prompt_id;
  }
}

export class ToolCallEvent implements BaseTelemetryEvent {
  'event.name': 'tool_call';
  'event.timestamp': string;
  function_name: string;
  function_args: Record<string, unknown>;
  duration_ms: number;
  status: 'success' | 'error' | 'cancelled';
  success: boolean; // Keep for backward compatibility
  decision?: ToolCallDecision;
  error?: string;
  error_type?: string;
  prompt_id: string;
  response_id?: string;
  tool_type: 'native' | 'mcp';
  content_length?: number;
  mcp_server_name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: { [key: string]: any };

  constructor(call: CompletedToolCall) {
    this['event.name'] = 'tool_call';
    this['event.timestamp'] = new Date().toISOString();
    this.function_name = call.request.name;
    // structured_output args ARE the user's final structured payload (the
    // command's actual answer, already emitted in stdout `result` /
    // `structured_result`). Recording them again as ordinary tool-call
    // function_args duplicates that data into telemetry surfaces (OTLP
    // exports, QwenLogger, ui-telemetry stream, the chat-recording UI
    // event mirror) where it can leak off-device. Replace with a shared
    // placeholder constant so consumers still see the call happened —
    // duration, success, decision metrics are preserved — but the
    // payload itself doesn't ride along. The same constant is used by
    // `redactStructuredOutputArgsForRecording` in `core/geminiChat.ts`
    // for the on-disk JSONL surface so neither side can silently drift.
    this.function_args =
      call.request.name === ToolNames.STRUCTURED_OUTPUT
        ? { ...STRUCTURED_OUTPUT_REDACTED_ARGS }
        : call.request.args;
    this.duration_ms = call.durationMs ?? 0;
    this.status = call.status;
    this.success = call.status === 'success'; // Keep for backward compatibility
    this.decision = call.outcome
      ? getDecisionFromOutcome(call.outcome)
      : undefined;
    this.error = call.response.error?.message;
    this.error_type = call.response.errorType;
    this.prompt_id = call.request.prompt_id;
    this.content_length = call.response.contentLength;
    if (
      typeof call.tool !== 'undefined' &&
      call.tool instanceof DiscoveredMCPTool
    ) {
      this.tool_type = 'mcp';
      this.mcp_server_name = call.tool.serverName;
    } else {
      this.tool_type = 'native';
    }
    this.response_id = call.request.response_id;

    if (
      call.status === 'success' &&
      typeof call.response.resultDisplay === 'object' &&
      call.response.resultDisplay !== null &&
      'diffStat' in call.response.resultDisplay
    ) {
      const diffStat = (call.response.resultDisplay as FileDiff).diffStat;
      if (diffStat) {
        this.metadata = {
          model_added_lines: diffStat.model_added_lines,
          model_removed_lines: diffStat.model_removed_lines,
          model_added_chars: diffStat.model_added_chars,
          model_removed_chars: diffStat.model_removed_chars,
          user_added_lines: diffStat.user_added_lines,
          user_removed_lines: diffStat.user_removed_lines,
          user_added_chars: diffStat.user_added_chars,
          user_removed_chars: diffStat.user_removed_chars,
        };
      }
    }
  }
}

export class ApiRequestEvent implements BaseTelemetryEvent {
  'event.name': 'api_request';
  'event.timestamp': string;
  model: string;
  prompt_id: string;
  request_text?: string;
  /**
   * Name of the subagent that issued this request, or undefined when the
   * request originates from the main conversation.
   */
  subagent_name?: string;

  constructor(
    model: string,
    prompt_id: string,
    request_text?: string,
    subagent_name?: string,
  ) {
    this['event.name'] = 'api_request';
    this['event.timestamp'] = new Date().toISOString();
    this.model = model;
    this.prompt_id = prompt_id;
    this.request_text = request_text;
    this.subagent_name = subagent_name;
  }
}

export class ApiErrorEvent implements BaseTelemetryEvent {
  'event.name': 'api_error';
  'event.timestamp': string; // ISO 8601
  response_id?: string;
  model: string;
  duration_ms: number;
  prompt_id: string;
  auth_type?: string;
  // Human-readable error message (e.g. "Request failed with status 429")
  error_message: string;
  // Error class or category (e.g. "RateLimitError", "invalid_request_error")
  error_type?: string;
  // HTTP status code from the API response (e.g. 429, 500)
  status_code?: number | string;
  /**
   * Name of the subagent that issued this request, or undefined when the
   * request originates from the main conversation.
   */
  subagent_name?: string;

  constructor(opts: {
    responseId?: string;
    model: string;
    durationMs: number;
    promptId: string;
    authType?: string;
    errorMessage: string;
    errorType?: string;
    statusCode?: number | string;
    subagentName?: string;
  }) {
    this['event.name'] = 'api_error';
    this['event.timestamp'] = new Date().toISOString();
    this.response_id = opts.responseId;
    this.model = opts.model;
    this.duration_ms = opts.durationMs;
    this.prompt_id = opts.promptId;
    this.auth_type = opts.authType;
    this.error_message = opts.errorMessage;
    this.error_type = opts.errorType;
    this.status_code = opts.statusCode;
    this.subagent_name = opts.subagentName;
  }
}

export class ApiCancelEvent implements BaseTelemetryEvent {
  'event.name': 'api_cancel';
  'event.timestamp': string;
  model: string;
  prompt_id: string;
  auth_type?: string;

  constructor(model: string, prompt_id: string, auth_type?: string) {
    this['event.name'] = 'api_cancel';
    this['event.timestamp'] = new Date().toISOString();
    this.model = model;
    this.prompt_id = prompt_id;
    this.auth_type = auth_type;
  }
}

export class ApiResponseEvent implements BaseTelemetryEvent {
  'event.name': 'api_response';
  'event.timestamp': string; // ISO 8601
  response_id: string;
  model: string;
  status_code?: number | string;
  duration_ms: number;
  input_token_count: number;
  output_token_count: number;
  cached_content_token_count: number;
  thoughts_token_count: number;
  total_token_count: number;
  response_text?: string;
  prompt_id: string;
  auth_type?: string;
  /**
   * Name of the subagent that issued this request, or undefined when the
   * request originates from the main conversation.
   */
  subagent_name?: string;

  constructor(
    response_id: string,
    model: string,
    duration_ms: number,
    prompt_id: string,
    auth_type?: string,
    usage_data?: GenerateContentResponseUsageMetadata,
    response_text?: string,
    subagent_name?: string,
  ) {
    this['event.name'] = 'api_response';
    this['event.timestamp'] = new Date().toISOString();
    this.response_id = response_id;
    this.model = model;
    this.duration_ms = duration_ms;
    this.status_code = 200;
    this.input_token_count = usage_data?.promptTokenCount ?? 0;
    this.output_token_count = usage_data?.candidatesTokenCount ?? 0;
    this.cached_content_token_count = usage_data?.cachedContentTokenCount ?? 0;
    this.thoughts_token_count = usage_data?.thoughtsTokenCount ?? 0;
    this.total_token_count = usage_data?.totalTokenCount ?? 0;
    this.response_text = response_text;
    this.prompt_id = prompt_id;
    this.auth_type = auth_type;
    this.subagent_name = subagent_name;
  }
}

export class FlashFallbackEvent implements BaseTelemetryEvent {
  'event.name': 'flash_fallback';
  'event.timestamp': string;
  auth_type: string;

  constructor(auth_type: string) {
    this['event.name'] = 'flash_fallback';
    this['event.timestamp'] = new Date().toISOString();
    this.auth_type = auth_type;
  }
}

export class RipgrepFallbackEvent implements BaseTelemetryEvent {
  'event.name': 'ripgrep_fallback';
  'event.timestamp': string;
  use_ripgrep: boolean;
  use_builtin_ripgrep: boolean;
  error?: string;

  constructor(
    use_ripgrep: boolean,
    use_builtin_ripgrep: boolean,
    error?: string,
  ) {
    this['event.name'] = 'ripgrep_fallback';
    this['event.timestamp'] = new Date().toISOString();
    this.use_ripgrep = use_ripgrep;
    this.use_builtin_ripgrep = use_builtin_ripgrep;
    this.error = error;
  }
}

export enum LoopType {
  CONSECUTIVE_IDENTICAL_TOOL_CALLS = 'consecutive_identical_tool_calls',
  CHANTING_IDENTICAL_SENTENCES = 'chanting_identical_sentences',
  REPETITIVE_THOUGHTS = 'repetitive_thoughts',
  READ_FILE_LOOP = 'read_file_loop',
  ACTION_STAGNATION = 'action_stagnation',
}

export class LoopDetectedEvent implements BaseTelemetryEvent {
  'event.name': 'loop_detected';
  'event.timestamp': string;
  loop_type: LoopType;
  prompt_id: string;

  constructor(loop_type: LoopType, prompt_id: string) {
    this['event.name'] = 'loop_detected';
    this['event.timestamp'] = new Date().toISOString();
    this.loop_type = loop_type;
    this.prompt_id = prompt_id;
  }
}

export class LoopDetectionDisabledEvent implements BaseTelemetryEvent {
  'event.name': 'loop_detection_disabled';
  'event.timestamp': string;
  prompt_id: string;

  constructor(prompt_id: string) {
    this['event.name'] = 'loop_detection_disabled';
    this['event.timestamp'] = new Date().toISOString();
    this.prompt_id = prompt_id;
  }
}

export class NextSpeakerCheckEvent implements BaseTelemetryEvent {
  'event.name': 'next_speaker_check';
  'event.timestamp': string;
  prompt_id: string;
  finish_reason: string;
  result: string;

  constructor(prompt_id: string, finish_reason: string, result: string) {
    this['event.name'] = 'next_speaker_check';
    this['event.timestamp'] = new Date().toISOString();
    this.prompt_id = prompt_id;
    this.finish_reason = finish_reason;
    this.result = result;
  }
}

export interface SlashCommandEvent extends BaseTelemetryEvent {
  'event.name': 'slash_command';
  'event.timestamp': string;
  command: string;
  subcommand?: string;
  status?: SlashCommandStatus;
}

export function makeSlashCommandEvent({
  command,
  subcommand,
  status,
}: Omit<SlashCommandEvent, CommonFields>): SlashCommandEvent {
  return {
    'event.name': 'slash_command',
    'event.timestamp': new Date().toISOString(),
    command,
    subcommand,
    status,
  };
}

export enum SlashCommandStatus {
  SUCCESS = 'success',
  ERROR = 'error',
}

export interface ChatCompressionEvent extends BaseTelemetryEvent {
  'event.name': 'chat_compression';
  'event.timestamp': string;
  tokens_before: number;
  tokens_after: number;
  compression_input_token_count?: number;
  compression_output_token_count?: number;
}

export function makeChatCompressionEvent({
  tokens_before,
  tokens_after,
  compression_input_token_count,
  compression_output_token_count,
}: Omit<ChatCompressionEvent, CommonFields>): ChatCompressionEvent {
  return {
    'event.name': 'chat_compression',
    'event.timestamp': new Date().toISOString(),
    tokens_before,
    tokens_after,
    ...(compression_input_token_count !== undefined
      ? { compression_input_token_count }
      : {}),
    ...(compression_output_token_count !== undefined
      ? { compression_output_token_count }
      : {}),
  };
}

export class MalformedJsonResponseEvent implements BaseTelemetryEvent {
  'event.name': 'malformed_json_response';
  'event.timestamp': string;
  model: string;

  constructor(model: string) {
    this['event.name'] = 'malformed_json_response';
    this['event.timestamp'] = new Date().toISOString();
    this.model = model;
  }
}

export enum IdeConnectionType {
  START = 'start',
  SESSION = 'session',
}

export class IdeConnectionEvent {
  'event.name': 'ide_connection';
  'event.timestamp': string;
  connection_type: IdeConnectionType;

  constructor(connection_type: IdeConnectionType) {
    this['event.name'] = 'ide_connection';
    this['event.timestamp'] = new Date().toISOString();
    this.connection_type = connection_type;
  }
}

export class ConversationFinishedEvent {
  'event_name': 'conversation_finished';
  'event.timestamp': string; // ISO 8601;
  approvalMode: ApprovalMode;
  turnCount: number;

  constructor(approvalMode: ApprovalMode, turnCount: number) {
    this['event_name'] = 'conversation_finished';
    this['event.timestamp'] = new Date().toISOString();
    this.approvalMode = approvalMode;
    this.turnCount = turnCount;
  }
}

export class KittySequenceOverflowEvent {
  'event.name': 'kitty_sequence_overflow';
  'event.timestamp': string; // ISO 8601
  sequence_length: number;
  truncated_sequence: string;
  constructor(sequence_length: number, truncated_sequence: string) {
    this['event.name'] = 'kitty_sequence_overflow';
    this['event.timestamp'] = new Date().toISOString();
    this.sequence_length = sequence_length;
    // Truncate to first 20 chars for logging (avoid logging sensitive data)
    this.truncated_sequence = truncated_sequence.substring(0, 20);
  }
}

export class FileOperationEvent implements BaseTelemetryEvent {
  'event.name': 'file_operation';
  'event.timestamp': string;
  tool_name: string;
  operation: FileOperation;
  lines?: number;
  mimetype?: string;
  extension?: string;
  programming_language?: string;

  constructor(
    tool_name: string,
    operation: FileOperation,
    lines?: number,
    mimetype?: string,
    extension?: string,
    programming_language?: string,
  ) {
    this['event.name'] = 'file_operation';
    this['event.timestamp'] = new Date().toISOString();
    this.tool_name = tool_name;
    this.operation = operation;
    this.lines = lines;
    this.mimetype = mimetype;
    this.extension = extension;
    this.programming_language = programming_language;
  }
}

// Add these new event interfaces
export class InvalidChunkEvent implements BaseTelemetryEvent {
  'event.name': 'invalid_chunk';
  'event.timestamp': string;
  error_message?: string; // Optional: validation error details

  constructor(error_message?: string) {
    this['event.name'] = 'invalid_chunk';
    this['event.timestamp'] = new Date().toISOString();
    this.error_message = error_message;
  }
}

export class ContentRetryEvent implements BaseTelemetryEvent {
  'event.name': 'content_retry';
  'event.timestamp': string;
  attempt_number: number;
  error_type: string; // e.g., 'EmptyStreamError'
  retry_delay_ms: number;
  model: string;

  constructor(
    attempt_number: number,
    error_type: string,
    retry_delay_ms: number,
    model: string,
  ) {
    this['event.name'] = 'content_retry';
    this['event.timestamp'] = new Date().toISOString();
    this.attempt_number = attempt_number;
    this.error_type = error_type;
    this.retry_delay_ms = retry_delay_ms;
    this.model = model;
  }
}

export class ContentRetryFailureEvent implements BaseTelemetryEvent {
  'event.name': 'content_retry_failure';
  'event.timestamp': string;
  total_attempts: number;
  final_error_type: string;
  total_duration_ms?: number; // Optional: total time spent retrying
  model: string;

  constructor(
    total_attempts: number,
    final_error_type: string,
    model: string,
    total_duration_ms?: number,
  ) {
    this['event.name'] = 'content_retry_failure';
    this['event.timestamp'] = new Date().toISOString();
    this.total_attempts = total_attempts;
    this.final_error_type = final_error_type;
    this.total_duration_ms = total_duration_ms;
    this.model = model;
  }
}

export class ExtensionInstallEvent implements BaseTelemetryEvent {
  'event.name': 'extension_install';
  'event.timestamp': string;
  extension_name: string;
  extension_version: string;
  extension_source: string;
  status: 'success' | 'error';

  constructor(
    extension_name: string,
    extension_version: string,
    extension_source: string,
    status: 'success' | 'error',
  ) {
    this['event.name'] = 'extension_install';
    this['event.timestamp'] = new Date().toISOString();
    this.extension_name = extension_name;
    this.extension_version = extension_version;
    this.extension_source = extension_source;
    this.status = status;
  }
}

export class ToolOutputTruncatedEvent implements BaseTelemetryEvent {
  readonly eventName = 'tool_output_truncated';
  readonly 'event.timestamp' = new Date().toISOString();
  'event.name': string;
  tool_name: string;
  original_content_length: number;
  truncated_content_length: number;
  threshold: number;
  lines: number;
  prompt_id: string;

  constructor(
    prompt_id: string,
    details: {
      toolName: string;
      originalContentLength: number;
      truncatedContentLength: number;
      threshold: number;
      lines: number;
    },
  ) {
    this['event.name'] = this.eventName;
    this.prompt_id = prompt_id;
    this.tool_name = details.toolName;
    this.original_content_length = details.originalContentLength;
    this.truncated_content_length = details.truncatedContentLength;
    this.threshold = details.threshold;
    this.lines = details.lines;
  }
}

export class ExtensionUninstallEvent implements BaseTelemetryEvent {
  'event.name': 'extension_uninstall';
  'event.timestamp': string;
  extension_name: string;
  status: 'success' | 'error';

  constructor(extension_name: string, status: 'success' | 'error') {
    this['event.name'] = 'extension_uninstall';
    this['event.timestamp'] = new Date().toISOString();
    this.extension_name = extension_name;
    this.status = status;
  }
}

export class ExtensionUpdateEvent implements BaseTelemetryEvent {
  'event.name': 'extension_update';
  'event.timestamp': string;
  extension_name: string;
  extension_id: string;
  extension_previous_version: string;
  extension_version: string;
  extension_source: string;
  status: 'success' | 'error';

  constructor(
    extension_name: string,
    extension_id: string,
    extension_version: string,
    extension_previous_version: string,
    extension_source: string,
    status: 'success' | 'error',
  ) {
    this['event.name'] = 'extension_update';
    this['event.timestamp'] = new Date().toISOString();
    this.extension_name = extension_name;
    this.extension_id = extension_id;
    this.extension_version = extension_version;
    this.extension_previous_version = extension_previous_version;
    this.extension_source = extension_source;
    this.status = status;
  }
}

export class ExtensionEnableEvent implements BaseTelemetryEvent {
  'event.name': 'extension_enable';
  'event.timestamp': string;
  extension_name: string;
  setting_scope: string;

  constructor(extension_name: string, settingScope: string) {
    this['event.name'] = 'extension_enable';
    this['event.timestamp'] = new Date().toISOString();
    this.extension_name = extension_name;
    this.setting_scope = settingScope;
  }
}

export class ModelSlashCommandEvent implements BaseTelemetryEvent {
  'event.name': 'model_slash_command';
  'event.timestamp': string;
  model_name: string;

  constructor(model_name: string) {
    this['event.name'] = 'model_slash_command';
    this['event.timestamp'] = new Date().toISOString();
    this.model_name = model_name;
  }
}

export class SubagentExecutionEvent implements BaseTelemetryEvent {
  'event.name': 'subagent_execution';
  'event.timestamp': string;
  subagent_name: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  terminate_reason?: string;
  result?: string;
  execution_summary?: string;

  constructor(
    subagent_name: string,
    status: 'started' | 'completed' | 'failed' | 'cancelled',
    options?: {
      terminate_reason?: string;
      result?: string;
      execution_summary?: string;
    },
  ) {
    this['event.name'] = 'subagent_execution';
    this['event.timestamp'] = new Date().toISOString();
    this.subagent_name = subagent_name;
    this.status = status;
    this.terminate_reason = options?.terminate_reason;
    this.result = options?.result;
    this.execution_summary = options?.execution_summary;
  }
}

export class AuthEvent implements BaseTelemetryEvent {
  'event.name': 'auth';
  'event.timestamp': string;
  auth_type: AuthType;
  action_type: 'auto' | 'manual' | 'coding-plan';
  status: 'success' | 'error' | 'cancelled';
  error_message?: string;

  constructor(
    auth_type: AuthType,
    action_type: 'auto' | 'manual' | 'coding-plan',
    status: 'success' | 'error' | 'cancelled',
    error_message?: string,
  ) {
    this['event.name'] = 'auth';
    this['event.timestamp'] = new Date().toISOString();
    this.auth_type = auth_type;
    this.action_type = action_type;
    this.status = status;
    this.error_message = error_message;
  }
}

/** Hook type for telemetry */
export type HookTelemetryType = 'command' | 'http' | 'function' | 'prompt';

/**
 * Hook call telemetry event
 */
export class HookCallEvent implements BaseTelemetryEvent {
  'event.name': string;
  'event.timestamp': string;
  hook_event_name: string;
  hook_type: HookTelemetryType;
  hook_name: string;
  hook_input: Record<string, unknown>;
  hook_output?: Record<string, unknown>;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  duration_ms: number;
  success: boolean;
  error?: string;

  constructor(
    hookEventName: string,
    hookType: HookTelemetryType,
    hookName: string,
    hookInput: Record<string, unknown>,
    durationMs: number,
    success: boolean,
    hookOutput?: Record<string, unknown>,
    exitCode?: number,
    stdout?: string,
    stderr?: string,
    error?: string,
  ) {
    this['event.name'] = 'hook_call';
    this['event.timestamp'] = new Date().toISOString();
    this.hook_event_name = hookEventName;
    this.hook_type = hookType;
    this.hook_name = hookName;
    this.hook_input = hookInput;
    this.hook_output = hookOutput;
    this.exit_code = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.duration_ms = durationMs;
    this.success = success;
    this.error = error;
  }
}

export class SkillLaunchEvent implements BaseTelemetryEvent {
  'event.name': 'skill_launch';
  'event.timestamp': string;
  skill_name: string;
  success: boolean;

  constructor(skill_name: string, success: boolean) {
    this['event.name'] = 'skill_launch';
    this['event.timestamp'] = new Date().toISOString();
    this.skill_name = skill_name;
    this.success = success;
  }
}

export enum UserFeedbackRating {
  BAD = 1,
  FINE = 2,
  GOOD = 3,
}

export class UserFeedbackEvent implements BaseTelemetryEvent {
  'event.name': 'user_feedback';
  'event.timestamp': string;
  session_id: string;
  rating: UserFeedbackRating;
  model: string;
  approval_mode: string;
  prompt_id?: string;

  constructor(
    session_id: string,
    rating: UserFeedbackRating,
    model: string,
    approval_mode: string,
    prompt_id?: string,
  ) {
    this['event.name'] = 'user_feedback';
    this['event.timestamp'] = new Date().toISOString();
    this.session_id = session_id;
    this.rating = rating;
    this.model = model;
    this.approval_mode = approval_mode;
    this.prompt_id = prompt_id;
  }
}

export type TelemetryEvent =
  | StartSessionEvent
  | EndSessionEvent
  | UserPromptEvent
  | ToolCallEvent
  | ApiRequestEvent
  | ApiErrorEvent
  | ApiCancelEvent
  | ApiResponseEvent
  | FlashFallbackEvent
  | LoopDetectedEvent
  | LoopDetectionDisabledEvent
  | NextSpeakerCheckEvent
  | KittySequenceOverflowEvent
  | MalformedJsonResponseEvent
  | IdeConnectionEvent
  | ConversationFinishedEvent
  | SlashCommandEvent
  | FileOperationEvent
  | InvalidChunkEvent
  | ContentRetryEvent
  | ContentRetryFailureEvent
  | SubagentExecutionEvent
  | ExtensionEnableEvent
  | ExtensionInstallEvent
  | ExtensionUninstallEvent
  | ToolOutputTruncatedEvent
  | ModelSlashCommandEvent
  | AuthEvent
  | HookCallEvent
  | SkillLaunchEvent
  | UserFeedbackEvent
  | ArenaSessionStartedEvent
  | ArenaAgentCompletedEvent
  | ArenaSessionEndedEvent;

// ─── Arena Telemetry Events ────────────────────────────────────

export interface ArenaSessionStartedEvent extends BaseTelemetryEvent {
  'event.name': 'arena_session_started';
  arena_session_id: string;
  model_ids: string[];
  task_length: number;
}

export function makeArenaSessionStartedEvent({
  arena_session_id,
  model_ids,
  task_length,
}: Omit<ArenaSessionStartedEvent, CommonFields>): ArenaSessionStartedEvent {
  return {
    'event.name': 'arena_session_started',
    'event.timestamp': new Date().toISOString(),
    arena_session_id,
    model_ids,
    task_length,
  };
}

export type ArenaAgentCompletedStatus = 'completed' | 'failed' | 'cancelled';

export interface ArenaAgentCompletedEvent extends BaseTelemetryEvent {
  'event.name': 'arena_agent_completed';
  arena_session_id: string;
  agent_session_id: string;
  agent_model_id: string;
  status: ArenaAgentCompletedStatus;
  duration_ms: number;
  rounds: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  successful_tool_calls: number;
  failed_tool_calls: number;
}

export function makeArenaAgentCompletedEvent({
  arena_session_id,
  agent_session_id,
  agent_model_id,
  status,
  duration_ms,
  rounds,
  total_tokens,
  input_tokens,
  output_tokens,
  tool_calls,
  successful_tool_calls,
  failed_tool_calls,
}: Omit<ArenaAgentCompletedEvent, CommonFields>): ArenaAgentCompletedEvent {
  return {
    'event.name': 'arena_agent_completed',
    'event.timestamp': new Date().toISOString(),
    arena_session_id,
    agent_session_id,
    agent_model_id,
    status,
    duration_ms,
    rounds,
    total_tokens,
    input_tokens,
    output_tokens,
    tool_calls,
    successful_tool_calls,
    failed_tool_calls,
  };
}

export type ArenaSessionEndedStatus =
  | 'selected'
  | 'discarded'
  | 'failed'
  | 'cancelled';

export interface ArenaSessionEndedEvent extends BaseTelemetryEvent {
  'event.name': 'arena_session_ended';
  arena_session_id: string;
  status: ArenaSessionEndedStatus;
  duration_ms: number;
  display_backend?: string;
  agent_count: number;
  completed_agents: number;
  failed_agents: number;
  cancelled_agents: number;
  winner_model_id?: string;
}

export function makeArenaSessionEndedEvent({
  arena_session_id,
  status,
  duration_ms,
  display_backend,
  agent_count,
  completed_agents,
  failed_agents,
  cancelled_agents,
  winner_model_id,
}: Omit<ArenaSessionEndedEvent, CommonFields>): ArenaSessionEndedEvent {
  return {
    'event.name': 'arena_session_ended',
    'event.timestamp': new Date().toISOString(),
    arena_session_id,
    status,
    duration_ms,
    display_backend,
    agent_count,
    completed_agents,
    failed_agents,
    cancelled_agents,
    winner_model_id,
  };
}

export class ExtensionDisableEvent implements BaseTelemetryEvent {
  'event.name': 'extension_disable';
  'event.timestamp': string;
  extension_name: string;
  setting_scope: string;

  constructor(extension_name: string, settingScope: string) {
    this['event.name'] = 'extension_disable';
    this['event.timestamp'] = new Date().toISOString();
    this.extension_name = extension_name;
    this.setting_scope = settingScope;
  }
}

export class PromptSuggestionEvent implements BaseTelemetryEvent {
  'event.name': 'qwen-code.prompt_suggestion';
  'event.timestamp': string;
  outcome: 'accepted' | 'ignored' | 'suppressed';
  prompt_id?: string;
  accept_method?: 'tab' | 'enter' | 'right';
  time_to_accept_ms?: number;
  time_to_ignore_ms?: number;
  time_to_first_keystroke_ms?: number;
  suggestion_length?: number;
  similarity?: number;
  was_focused_when_shown?: boolean;
  reason?: string;

  constructor(params: {
    outcome: 'accepted' | 'ignored' | 'suppressed';
    prompt_id?: string;
    accept_method?: 'tab' | 'enter' | 'right';
    time_to_accept_ms?: number;
    time_to_ignore_ms?: number;
    time_to_first_keystroke_ms?: number;
    suggestion_length?: number;
    similarity?: number;
    was_focused_when_shown?: boolean;
    reason?: string;
  }) {
    this['event.name'] = 'qwen-code.prompt_suggestion';
    this['event.timestamp'] = new Date().toISOString();
    this.outcome = params.outcome;
    this.prompt_id = params.prompt_id ?? 'user_intent';
    this.accept_method = params.accept_method;
    this.time_to_accept_ms = params.time_to_accept_ms;
    this.time_to_ignore_ms = params.time_to_ignore_ms;
    this.time_to_first_keystroke_ms = params.time_to_first_keystroke_ms;
    this.suggestion_length = params.suggestion_length;
    this.similarity = params.similarity;
    this.was_focused_when_shown = params.was_focused_when_shown;
    this.reason = params.reason;
  }
}

export class SpeculationEvent implements BaseTelemetryEvent {
  'event.name': 'qwen-code.speculation';
  'event.timestamp': string;
  outcome: 'accepted' | 'aborted' | 'failed';
  turns_used: number;
  files_written: number;
  tool_use_count: number;
  duration_ms: number;
  boundary_type?: string;
  had_pipelined_suggestion: boolean;

  constructor(params: {
    outcome: 'accepted' | 'aborted' | 'failed';
    turns_used: number;
    files_written: number;
    tool_use_count: number;
    duration_ms: number;
    boundary_type?: string;
    had_pipelined_suggestion: boolean;
  }) {
    this['event.name'] = 'qwen-code.speculation';
    this['event.timestamp'] = new Date().toISOString();
    this.outcome = params.outcome;
    this.turns_used = params.turns_used;
    this.files_written = params.files_written;
    this.tool_use_count = params.tool_use_count;
    this.duration_ms = params.duration_ms;
    this.boundary_type = params.boundary_type;
    this.had_pipelined_suggestion = params.had_pipelined_suggestion;
  }
}

// ---------------------------------------------------------------------------
// Managed Auto-Memory Events
// ---------------------------------------------------------------------------

export class MemoryExtractEvent implements BaseTelemetryEvent {
  'event.name': 'qwen-code.memory.extract';
  'event.timestamp': string;
  /** 'auto' = triggered by session turn; 'manual' = user-initiated */
  trigger: 'auto' | 'manual';
  status: 'completed' | 'skipped' | 'failed';
  skipped_reason?: 'already_running' | 'queued' | 'memory_tool';
  patches_count: number;
  touched_topics: string;
  duration_ms: number;

  constructor(params: {
    trigger: 'auto' | 'manual';
    status: 'completed' | 'skipped' | 'failed';
    skipped_reason?: 'already_running' | 'queued' | 'memory_tool';
    patches_count: number;
    touched_topics: string[];
    duration_ms: number;
  }) {
    this['event.name'] = 'qwen-code.memory.extract';
    this['event.timestamp'] = new Date().toISOString();
    this.trigger = params.trigger;
    this.status = params.status;
    this.skipped_reason = params.skipped_reason;
    this.patches_count = params.patches_count;
    this.touched_topics = params.touched_topics.join(',');
    this.duration_ms = params.duration_ms;
  }
}

export class MemoryDreamEvent implements BaseTelemetryEvent {
  'event.name': 'qwen-code.memory.dream';
  'event.timestamp': string;
  /** 'auto' = scheduler-triggered; 'manual' = user ran /dream */
  trigger: 'auto' | 'manual';
  status: 'updated' | 'noop' | 'failed' | 'cancelled';
  deduped_entries: number;
  touched_topics_count: number;
  touched_topics: string;
  duration_ms: number;

  constructor(params: {
    trigger: 'auto' | 'manual';
    status: 'updated' | 'noop' | 'failed' | 'cancelled';
    deduped_entries: number;
    touched_topics: string[];
    duration_ms: number;
  }) {
    this['event.name'] = 'qwen-code.memory.dream';
    this['event.timestamp'] = new Date().toISOString();
    this.trigger = params.trigger;
    this.status = params.status;
    this.deduped_entries = params.deduped_entries;
    this.touched_topics_count = params.touched_topics.length;
    this.touched_topics = params.touched_topics.join(',');
    this.duration_ms = params.duration_ms;
  }
}

export class MemoryRecallEvent implements BaseTelemetryEvent {
  'event.name': 'qwen-code.memory.recall';
  'event.timestamp': string;
  query_length: number;
  docs_scanned: number;
  docs_selected: number;
  strategy: 'none' | 'heuristic' | 'model';
  duration_ms: number;

  constructor(params: {
    query_length: number;
    docs_scanned: number;
    docs_selected: number;
    strategy: 'none' | 'heuristic' | 'model';
    duration_ms: number;
  }) {
    this['event.name'] = 'qwen-code.memory.recall';
    this['event.timestamp'] = new Date().toISOString();
    this.query_length = params.query_length;
    this.docs_scanned = params.docs_scanned;
    this.docs_selected = params.docs_selected;
    this.strategy = params.strategy;
    this.duration_ms = params.duration_ms;
  }
}
