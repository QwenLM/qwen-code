/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Centralized diagnostic event emission.
 *
 * All structured session logging flows through this module. Downstream code
 * should call the typed `emit*` helpers rather than importing `sessionLogger`
 * directly — this keeps the logging schema in one place and eliminates
 * duplicate event emissions.
 *
 * Guiding principles:
 * - Each `emit*` function maps 1:1 to a `type` string in the session log.
 * - Parameters are typed and self-documenting.
 * - `sessionLogger` is only imported here and in infrastructure code
 *   (runLogger, the feedback collector, diagnosticLogCleanup).
 */

import {
  sessionLogger,
  normalizeDiagnosticValue,
  summarizeDiagnosticText,
} from './sessionLogger.js';
import type { DiagnosticLogLevel } from './sessionLogger.js';
import type { ModelPrompt } from '../provider/modelStreamRequest.js';
import { requestPrefixFacts } from './requestPrefixDiagnostics.js';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

export const ENV_EXPOSE_REQUEST_PREFIX_DIAGNOSTICS = `${BRAND_FIXED_ENV_PREFIX}EXPOSE_REQUEST_PREFIX_DIAGNOSTICS`;

/**
 * Format an unknown error value for diagnostic logging.
 * Extracts stack/message from Error objects, stringifies everything else.
 */
function formatErrorForLog(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function readErrorRecord(error: unknown): Record<string, unknown> | undefined {
  return error !== null && typeof error === 'object'
    ? (error as Record<string, unknown>)
    : undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return error.message;
  const record = readErrorRecord(error);
  if (typeof record?.['message'] === 'string') return record['message'];
  return String(error);
}

function readErrorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name || error.constructor.name;
  const record = readErrorRecord(error);
  return typeof record?.['name'] === 'string' ? record['name'] : undefined;
}

function readErrorCode(error: unknown): string | undefined {
  const record = readErrorRecord(error);
  return typeof record?.['code'] === 'string' ? record['code'] : undefined;
}

function readErrorStatus(error: unknown): number | undefined {
  const record = readErrorRecord(error);
  const status = record?.['status'] ?? record?.['httpStatus'];
  return typeof status === 'number' ? status : undefined;
}

function collectErrorCauseChain(error: unknown): Array<{
  name?: string;
  message?: string;
  code?: string;
  status?: number;
}> {
  const chain: Array<{
    name?: string;
    message?: string;
    code?: string;
    status?: number;
  }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (
    current !== undefined &&
    current !== null &&
    !seen.has(current) &&
    chain.length < 6
  ) {
    seen.add(current);
    chain.push({
      name: readErrorName(current),
      message: readErrorMessage(current),
      code: readErrorCode(current),
      status: readErrorStatus(current),
    });

    const record = readErrorRecord(current);
    current = record?.['cause'];
  }

  if (current !== undefined && current !== null) {
    chain.push({ message: '[Truncated or circular error cause]' });
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export function emitInputPromptReceived(params: {
  sessionId: string;
  turnId: string;
  prompt: string;
  commandMode: string | undefined;
  querySource: string | undefined;
  bridgeOrigin: boolean | undefined;
  skipSlashCommands: boolean | undefined;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'input',
    type: 'input.prompt.received',
    ids: { session_id: params.sessionId, turn_id: params.turnId },
    data: {
      ...summarizeDiagnosticText(params.prompt),
      command_mode: params.commandMode,
      query_source: params.querySource,
      bridge_origin: params.bridgeOrigin,
      skip_slash_commands: params.skipSlashCommands,
    },
  });
}

export function emitInputPromptSubmitted(params: {
  sessionId: string;
  turnId: string;
  prompt: string;
  isMeta: boolean;
  isSubagent: boolean;
  skipInitialUserMessage: boolean;
  originKind: string | undefined;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'input',
    type: 'input.prompt.submitted',
    ids: { session_id: params.sessionId, turn_id: params.turnId },
    data: {
      ...summarizeDiagnosticText(params.prompt),
      is_meta: params.isMeta,
      is_subagent: params.isSubagent,
      skip_initial_user_message: params.skipInitialUserMessage,
      origin_kind: params.originKind,
    },
  });
}

export function emitAttachmentGeneratorFinished(params: {
  sessionId: string | undefined;
  turnId: string | undefined;
  loopId?: string;
  phase: string | undefined;
  label: string;
  status: 'success' | 'error' | 'timeout';
  count?: number;
  durationMs: number;
  error?: unknown;
}): void {
  sessionLogger.event({
    level: params.status === 'success' ? 'info' : 'warn',
    kind: 'input',
    type: 'attachment.generator.finished',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
    },
    data: {
      phase: params.phase,
      label: params.label,
      status: params.status,
      count: params.count,
      duration_ms: params.durationMs,
      error: formatErrorForLog(params.error),
    },
  });
}

// ---------------------------------------------------------------------------
// Session phases
// ---------------------------------------------------------------------------

export function emitSessionPhaseStarted(params: {
  sessionId: string | undefined;
  phase: string;
  data?: Record<string, unknown>;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'session',
    type: 'session.phase.started',
    ids: { session_id: params.sessionId },
    data: {
      phase: params.phase,
      ...params.data,
    },
  });
}

export function emitSessionPhaseFinished(params: {
  sessionId: string | undefined;
  phase: string;
  durationMs?: number;
  success?: boolean;
  error?: unknown;
  data?: Record<string, unknown>;
}): void {
  const success = params.success !== false;
  sessionLogger.event({
    level: success ? 'info' : 'warn',
    kind: success ? 'session' : 'error',
    type: 'session.phase.finished',
    ids: { session_id: params.sessionId },
    data: {
      phase: params.phase,
      duration_ms: params.durationMs,
      success,
      error: formatErrorForLog(params.error),
      ...params.data,
    },
  });
}

// ---------------------------------------------------------------------------
// Turn / Loop
// ---------------------------------------------------------------------------

export function emitTurnStarted(params: {
  sessionId: string;
  turnId: string;
  model: string;
  promptLength: number;
  historyLength: number;
  skipInitialUserMessage: boolean;
  skipBeforeHook: boolean;
  isSubagent: boolean;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'turn',
    type: 'turn.started',
    ids: { session_id: params.sessionId, turn_id: params.turnId },
    data: {
      model: params.model,
      prompt_length: params.promptLength,
      history_length: params.historyLength,
      skip_initial_user_message: params.skipInitialUserMessage,
      skip_before_hook: params.skipBeforeHook,
      is_subagent: params.isSubagent,
    },
  });
}

interface TurnFinishedData {
  reason: string;
  modelStopReason: string | undefined;
  numTurns: number;
  durationMs: number;
  error: string | undefined;
  requestId: string | undefined;
  clientRequestId: string | undefined;
  serverRequestId: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function emitTurnFinished(
  params: { sessionId: string; turnId: string } & TurnFinishedData,
): void {
  const isError = params.reason === 'error';
  sessionLogger.event({
    level: isError ? 'error' : 'info',
    kind: isError ? 'error' : 'turn',
    type: 'turn.finished',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      request_id: params.requestId,
    },
    data: {
      reason: params.reason,
      model_stop_reason: params.modelStopReason,
      num_turns: params.numTurns,
      duration_ms: params.durationMs,
      error: params.error,
      request_id: params.requestId,
      client_request_id: params.clientRequestId,
      server_request_id: params.serverRequestId,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cache_read_input_tokens: params.cacheReadInputTokens,
      cache_creation_input_tokens: params.cacheCreationInputTokens,
    },
  });
}

export function emitLoopStarted(params: {
  sessionId: string;
  turnId: string;
  loopId: string;
  requestIndex: number;
  model: string;
  requestMessageCount: number;
  requestBaseHistoryLength: number;
  hasPendingUserMessage: boolean;
  toolSchemaCount: number;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'loop',
    type: 'loop.iteration.started',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
    },
    data: {
      request_index: params.requestIndex,
      model: params.model,
      request_message_count: params.requestMessageCount,
      request_base_history_length: params.requestBaseHistoryLength,
      has_pending_user_message: params.hasPendingUserMessage,
      tool_schema_count: params.toolSchemaCount,
    },
  });
}

export function emitLoopFinished(params: {
  sessionId: string;
  turnId: string;
  loopId: string;
  requestIndex: number;
  reason: string;
  level?: DiagnosticLogLevel;
  data?: Record<string, unknown>;
}): void {
  const level = params.level ?? 'info';
  sessionLogger.event({
    level,
    kind: level === 'error' ? 'error' : 'loop',
    type: 'loop.iteration.finished',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
    },
    data: {
      request_index: params.requestIndex,
      reason: params.reason,
      ...params.data,
    },
  });
}

export function emitCompressionProgress(params: {
  stage: string;
  trigger: string;
  sessionScopeId: string;
  target: 'main' | 'subagent';
  agentId?: string;
  tokensBeforeCompact?: number;
  tokensAfterCompact?: number;
  failureReason?: string;
}): void {
  sessionLogger.event({
    level: params.stage === 'failed' ? 'warn' : 'info',
    kind: 'loop',
    type: 'compression.progress',
    ids: { session_id: params.sessionScopeId },
    data: {
      stage: params.stage,
      trigger: params.trigger,
      target: params.target,
      agent_id: params.agentId,
      session_scope_id: params.sessionScopeId,
      tokens_before_compact: params.tokensBeforeCompact,
      tokens_after_compact: params.tokensAfterCompact,
      failure_reason: params.failureReason,
    },
  });
}

export function emitForkAgentStarted(params: {
  sessionScopeId?: string;
  forkLabel: string;
  promptId: string;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'loop',
    type: 'fork.agent.started',
    ids: { session_id: params.sessionScopeId },
    data: {
      fork_label: params.forkLabel,
      prompt_id: params.promptId,
    },
  });
}

export function emitForkAgentCompleted(params: {
  sessionScopeId?: string;
  forkLabel: string;
  promptId: string;
  requestId: string | undefined;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  success: boolean;
}): void {
  sessionLogger.event({
    level: params.success ? 'info' : 'warn',
    kind: 'loop',
    type: 'fork.agent.completed',
    ids: {
      session_id: params.sessionScopeId,
      request_id: params.requestId,
    },
    data: {
      fork_label: params.forkLabel,
      prompt_id: params.promptId,
      request_id: params.requestId,
      duration_ms: params.durationMs,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cache_read_input_tokens: params.cacheReadInputTokens,
      cache_creation_input_tokens: params.cacheCreationInputTokens,
      success: params.success,
    },
  });
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function emitToolRequested(params: {
  sessionId: string;
  turnId: string;
  loopId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'tool',
    type: 'tool.requested',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      tool_call_id: params.toolCallId,
    },
    data: {
      tool_name: params.toolName,
      args: normalizeDiagnosticValue(params.args),
    },
  });
}

export function emitToolExecutionStarted(params: {
  sessionId: string;
  turnId: string;
  loopId: string;
  toolCallId: string;
  toolName: string;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'tool',
    type: 'tool.execution.started',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      tool_call_id: params.toolCallId,
    },
    data: {
      tool_name: params.toolName,
    },
  });
}

export function emitToolExecutionFinished(params: {
  sessionId: string;
  turnId: string;
  loopId: string;
  toolCallId: string;
  toolName: string;
  status: 'success' | 'denied' | 'error';
  isError: boolean;
  deniedByPermission: boolean;
  contentType: 'text' | 'parts';
  textChars: number;
  partCount?: number;
  imageCount?: number;
}): void {
  sessionLogger.event({
    level: params.status === 'success' ? 'info' : 'warn',
    kind: 'tool',
    type: 'tool.execution.finished',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      tool_call_id: params.toolCallId,
    },
    data: {
      tool_name: params.toolName,
      status: params.status,
      is_error: params.isError,
      denied_by_permission: params.deniedByPermission,
      content_type: params.contentType,
      text_chars: params.textChars,
      part_count: params.partCount,
      image_count: params.imageCount,
    },
  });
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function emitShellStarted(params: {
  sessionId: string | undefined;
  turnId?: string;
  toolCallId?: string;
  command: string;
  cwd: string;
  shellType: string;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'tool',
    type: 'tool.shell.started',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      command: params.command,
      cwd: params.cwd,
      shell_type: params.shellType,
    },
  });
}

export function emitShellFinished(params: {
  sessionId: string | undefined;
  turnId?: string;
  toolCallId?: string;
  pid: number | undefined;
  exitCode: number | null;
  signal: number | string | undefined;
  aborted: boolean;
  binaryOutput: boolean;
  outputLength: number;
  outputPath: string | undefined;
  error: string | undefined;
}): void {
  const hasError = !!params.error || params.exitCode !== 0;
  sessionLogger.event({
    level: hasError ? 'warn' : 'info',
    kind: 'tool',
    type: 'tool.shell.finished',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      pid: params.pid,
      exit_code: params.exitCode,
      signal: params.signal,
      aborted: params.aborted,
      binary_output: params.binaryOutput,
      output_length: params.outputLength,
      output_path: params.outputPath,
      error: params.error,
    },
  });
}

export function emitShellFailed(params: {
  sessionId: string | undefined;
  turnId?: string;
  toolCallId?: string;
  command: string;
  cwd: string;
  error: string;
}): void {
  sessionLogger.event({
    level: 'error',
    kind: 'tool',
    type: 'tool.shell.failed',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      command: params.command,
      cwd: params.cwd,
      error: params.error,
    },
  });
}

export function emitShellKillRequested(pid: number): void {
  sessionLogger.event({
    level: 'warn',
    kind: 'tool',
    type: 'tool.shell.kill_requested',
    data: { pid },
  });
}

export function emitShellBackgrounded(params: {
  sessionId: string | undefined;
  pid: number;
  command: string | undefined;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'tool',
    type: 'tool.shell.backgrounded',
    ids: { session_id: params.sessionId },
    data: { pid: params.pid, command: params.command },
  });
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Opt-in local diagnostics; a logging failure must not change inference. */
export function emitModelRequestPrefix(params: {
  sessionId: string | undefined;
  requestId: string;
  prompt: ModelPrompt;
}): void {
  if (process.env[ENV_EXPOSE_REQUEST_PREFIX_DIAGNOSTICS] !== '1') return;
  try {
    sessionLogger.event({
      level: 'info',
      kind: 'model',
      type: 'model.request.prefix',
      ids: { session_id: params.sessionId, request_id: params.requestId },
      data: requestPrefixFacts(params.prompt),
    });
  } catch {
    // Diagnostics are best effort and never contain raw prompt data.
  }
}

export function emitModelRequestStarted(params: {
  sessionId: string;
  turnId: string;
  loopId: string | undefined;
  requestId: string;
  requestIndex: number | undefined;
  model: string;
  requestMessageCount: number;
  toolSchemaCount: number;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'model',
    type: 'model.request.started',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      request_id: params.requestId,
    },
    data: {
      request_index: params.requestIndex,
      request_id: params.requestId,
      model: params.model,
      request_message_count: params.requestMessageCount,
      tool_schema_count: params.toolSchemaCount,
    },
  });
}

export function emitModelRequestPreparation(params: {
  sessionId: string;
  turnId: string;
  loopId: string | undefined;
  requestId: string;
  requestSetId: string | undefined;
  model: string;
  boundary: 'network_dispatch' | 'transport_handle_return';
  timing: {
    user_message_to_request_ms?: number;
    request_preparation_timing_json?: string;
    user_prompt_submit_hook_count?: number;
    user_prompt_submit_hook_blocking_ms?: number;
    sdk_startup_to_request_ms?: number;
    sdk_message_to_request_ms?: number;
  };
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'model',
    type: 'model.request.preparation',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      request_id: params.requestId,
    },
    data: {
      request_set_id: params.requestSetId,
      model: params.model,
      boundary: params.boundary,
      ...params.timing,
    },
  });
}

export function emitModelRequestFailed(params: {
  sessionId: string;
  turnId: string;
  loopId: string | undefined;
  requestId: string;
  requestIndex: number | undefined;
  status: number;
  bodyLength: number;
  bodyPreview: string;
}): void {
  sessionLogger.event({
    level: 'error',
    kind: 'error',
    type: 'model.request.failed',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      request_id: params.requestId,
    },
    data: {
      request_index: params.requestIndex,
      status: params.status,
      body_length: params.bodyLength,
      body_preview: params.bodyPreview,
    },
  });
}

export function emitModelRequestAttemptFailed(params: {
  sessionId: string;
  turnId: string;
  loopId: string | undefined;
  requestId: string;
  requestIndex: number | undefined;
  serverRequestId: string | undefined;
  attempt: number;
  maxAttempts: number;
  status: number | undefined;
  error: unknown;
  retryable: boolean;
  willRetry: boolean;
  retryFetchErrors: boolean;
  attemptHadPayload: boolean;
  attemptHadReplayUnsafePayload: boolean;
  streamEventCount: number;
  pendingEventCount: number;
  streamReadCompleted: boolean;
  isEmptyResponseBody: boolean;
  emptyAssistantCompletion?: {
    reason: string;
    contentBlockCount: number;
    reasoningBlockCount: number;
    textCharacterCount: number;
    replayCount: number;
  };
  aborted: boolean;
}): void {
  sessionLogger.event({
    level: params.willRetry ? 'warn' : 'error',
    kind: params.willRetry ? 'model' : 'error',
    type: 'model.request.attempt_failed',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      request_id: params.requestId,
    },
    data: {
      request_index: params.requestIndex,
      request_id: params.requestId,
      server_request_id: params.serverRequestId,
      attempt: params.attempt,
      max_attempts: params.maxAttempts,
      status: params.status,
      error_message: readErrorMessage(params.error),
      error_name: readErrorName(params.error),
      error_code: readErrorCode(params.error),
      error_status: readErrorStatus(params.error),
      error_cause_chain: collectErrorCauseChain(params.error),
      retryable: params.retryable,
      will_retry: params.willRetry,
      retry_fetch_errors: params.retryFetchErrors,
      attempt_had_payload: params.attemptHadPayload,
      attempt_had_replay_unsafe_payload: params.attemptHadReplayUnsafePayload,
      stream_event_count: params.streamEventCount,
      pending_event_count: params.pendingEventCount,
      stream_read_completed: params.streamReadCompleted,
      is_empty_response_body: params.isEmptyResponseBody,
      empty_assistant_completion_reason:
        params.emptyAssistantCompletion?.reason,
      empty_assistant_completion_content_block_count:
        params.emptyAssistantCompletion?.contentBlockCount,
      empty_assistant_completion_reasoning_block_count:
        params.emptyAssistantCompletion?.reasoningBlockCount,
      empty_assistant_completion_text_character_count:
        params.emptyAssistantCompletion?.textCharacterCount,
      empty_assistant_completion_replay_count:
        params.emptyAssistantCompletion?.replayCount,
      aborted: params.aborted,
    },
  });
}

export function emitModelResponseCompleted(params: {
  sessionId: string;
  turnId: string;
  loopId: string | undefined;
  requestId: string;
  requestIndex: number | undefined;
  provider: string;
  model: string;
  stopReason: string | null;
  contentBlockCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'model',
    type: 'model.response.completed',
    preserveSessionTokenUsage: params.provider === 'custom',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      loop_id: params.loopId,
      request_id: params.requestId,
    },
    data: {
      request_index: params.requestIndex,
      request_id: params.requestId,
      provider: params.provider,
      model: params.model,
      stop_reason: params.stopReason,
      content_block_count: params.contentBlockCount,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cache_read_input_tokens: params.cacheReadInputTokens,
      cache_creation_input_tokens: params.cacheCreationInputTokens,
    },
  });
}

export function emitModelRetryScheduled(params: {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string | undefined;
  model: string;
}): void {
  sessionLogger.event({
    level: 'warn',
    kind: 'model',
    type: 'model.retry_scheduled',
    data: {
      attempt: params.attempt,
      max_attempts: params.maxAttempts,
      delay_ms: params.delayMs,
      error: params.error,
      model: params.model,
    },
  });
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

export function emitPermissionRequested(params: {
  sessionId: string | undefined;
  turnId: string | undefined;
  toolCallId: string | undefined;
  toolName: string;
  input: unknown;
  askMessage?: string;
  suggestionCount?: number;
  suggestions?: unknown;
  confirmationDetails?: Record<string, unknown>;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'permission',
    type: 'permission.requested',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      tool_name: params.toolName,
      args: normalizeDiagnosticValue(params.input),
      ask_message: params.askMessage,
      suggestion_count: params.suggestionCount ?? 0,
      suggestions:
        params.suggestions !== undefined
          ? normalizeDiagnosticValue(params.suggestions)
          : undefined,
      ...params.confirmationDetails,
    },
  });
}

export function emitPermissionResolved(params: {
  sessionId: string | undefined;
  turnId: string | undefined;
  toolCallId: string | undefined;
  toolName: string;
  source?: string;
  allowed: boolean;
  outcome?: string;
  reason?: string;
  decisionBehavior?: string;
  decisionReason?: unknown;
  updatedInput?: Record<string, unknown>;
  permissionUpdateCount?: number;
  permissionUpdates?: unknown;
  durationMs?: number;
}): void {
  sessionLogger.event({
    level: params.allowed ? 'info' : 'warn',
    kind: 'permission',
    type: 'permission.resolved',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      tool_name: params.toolName,
      source: params.source,
      allowed: params.allowed,
      outcome: params.outcome,
      reason: params.reason,
      decision_behavior: params.decisionBehavior,
      decision_reason: params.decisionReason,
      updated_input: params.updatedInput !== undefined,
      updated_args:
        params.updatedInput !== undefined
          ? normalizeDiagnosticValue(params.updatedInput)
          : undefined,
      permission_update_count: params.permissionUpdateCount ?? 0,
      permission_updates: normalizeDiagnosticValue(params.permissionUpdates),
      duration_ms: params.durationMs,
    },
  });
}

export function emitPermissionFailed(params: {
  sessionId: string | undefined;
  turnId: string | undefined;
  toolCallId: string | undefined;
  toolName: string;
  source?: string;
  error: unknown;
  durationMs?: number;
}): void {
  sessionLogger.event({
    level: 'error',
    kind: 'permission',
    type: 'permission.failed',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      tool_name: params.toolName,
      source: params.source,
      error: formatErrorForLog(params.error),
      duration_ms: params.durationMs,
    },
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function emitTurnHookFailed(params: {
  sessionId: string;
  turnId: string;
  agentId?: string;
  stepIndex?: number;
  moduleId: string;
  stage: string;
  error: unknown;
}): void {
  sessionLogger.event({
    level: 'warn',
    kind: 'hook',
    type: 'hook.module_failed',
    ids: { session_id: params.sessionId, turn_id: params.turnId },
    data: {
      module_id: params.moduleId,
      stage: params.stage,
      agent_id: params.agentId,
      step_index: params.stepIndex,
      error: formatErrorForLog(params.error),
    },
  });
}

export function emitHookStarted(params: {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  hookName: string;
  eventName: string;
  source?: string;
  hookIndex?: number;
  totalHooks?: number;
  statusMessage?: string;
  displayText?: string;
  pluginId?: string;
  pluginRoot?: string;
  hookInput?: unknown;
}): void {
  sessionLogger.event({
    level: 'info',
    kind: 'hook',
    type: 'hook.started',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      hook_name: params.hookName,
      hook_event_name: params.eventName,
      source: params.source,
      hook_index: params.hookIndex,
      total_hooks: params.totalHooks,
      status_message: params.statusMessage,
      display_text: params.displayText,
      plugin_id: params.pluginId,
      plugin_root: params.pluginRoot,
      hook_input:
        params.hookInput !== undefined
          ? normalizeDiagnosticValue(params.hookInput)
          : undefined,
    },
  });
}

export function emitHookFinished(params: {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  hookName: string;
  eventName: string;
  source?: string;
  success: boolean;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  pluginId?: string;
  pluginRoot?: string;
  hookOutput?: unknown;
}): void {
  sessionLogger.event({
    level: params.success ? 'info' : 'warn',
    kind: 'hook',
    type: 'hook.finished',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: {
      hook_name: params.hookName,
      hook_event_name: params.eventName,
      source: params.source,
      success: params.success,
      duration_ms: params.durationMs,
      exit_code: params.exitCode,
      error: params.error,
      plugin_id: params.pluginId,
      plugin_root: params.pluginRoot,
      hook_output:
        params.hookOutput !== undefined
          ? normalizeDiagnosticValue(params.hookOutput)
          : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Feedback / Console / Output
// ---------------------------------------------------------------------------

export function emitFeedbackEvent(params: {
  severity: 'info' | 'warning' | 'error';
  message: string;
  error?: unknown;
}): void {
  const level: DiagnosticLogLevel =
    params.severity === 'error'
      ? 'error'
      : params.severity === 'warning'
        ? 'warn'
        : 'info';
  const formattedError = formatErrorForLog(params.error);
  sessionLogger.event({
    level,
    kind: params.severity === 'error' ? 'error' : 'feedback',
    type: 'feedback.emitted',
    summary: params.message,
    data: { has_error: params.error !== undefined, error: formattedError },
  });
}

export function emitConsoleCaptured(
  type: 'log' | 'warn' | 'error' | 'debug' | 'info',
  content: string,
): void {
  // Cap captured console output to prevent unbounded log growth
  const MAX_CONSOLE_CAPTURE = 8000;
  const truncated = content.length > MAX_CONSOLE_CAPTURE;
  const safeContent = truncated
    ? content.slice(0, MAX_CONSOLE_CAPTURE) +
      `…[truncated, total ${content.length} chars]`
    : content;
  sessionLogger.text(
    type === 'error'
      ? 'error'
      : type === 'warn'
        ? 'warn'
        : type === 'debug'
          ? 'debug'
          : 'info',
    'console.captured',
    safeContent,
    { console_type: type, truncated, original_length: content.length },
  );
}

export function emitStdioOutput(params: {
  isStderr: boolean;
  preview: string;
  byteLength: number;
  truncated: boolean;
}): void {
  sessionLogger.text(
    params.isStderr ? 'warn' : 'debug',
    'stdio.output',
    params.truncated ? `${params.preview}...` : params.preview,
    {
      stream: params.isStderr ? 'stderr' : 'stdout',
      byte_length: params.byteLength,
      truncated: params.truncated,
    },
  );
}

/** Read 的阶段和收敛日志只包含稳定事实，不接收路径、正文或原始异常。 */
export function emitReadFileDiagnostic(params: {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  agentId?: string;
  data: {
    event: 'phase_started' | 'phase_finished' | 'finished' | 'late_settlement';
    phase?: string;
    phases?: string[];
    status?: 'success' | 'failed' | 'timeout' | 'cancelled' | 'discarded';
    duration_ms?: number;
    timeout_ms?: number;
    operation_pending?: boolean;
    error_code?: string;
  };
}): void {
  sessionLogger.event({
    level: params.data.status === 'timeout' ? 'warn' : 'info',
    kind: 'tool',
    type: 'tool.read.diagnostic',
    ids: {
      session_id: params.sessionId,
      turn_id: params.turnId,
      tool_call_id: params.toolCallId,
    },
    data: { tool_name: 'Read', agent_id: params.agentId, ...params.data },
  });
}
