/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 手动压缩（`/compact`）的 wire 帧构造器：压缩状态帧、压缩后历史投影、本地命令回显与
 * 合成的 `result` 终态帧。帧形状（subtype、字段、`num_turns`）是对宿主的契约。
 */

import { randomUUID } from 'node:crypto';
import {
  cloneUsage,
  CompressionStatus,
  FatalCancellationError,
  getResultErrorCode,
  isCancellationError,
  projectCompactBoundaryForSdk,
  splitAssistantForSdk,
  splitUserForSdk,
  type ChatCompressionInfo,
  type Message,
  type SDKMessage,
  type SDKStatus,
} from '@qwen-code/core';
import {
  COMPACT_NOOP_TEXT,
  getCompactErrorText,
} from '../../../utils/compressionFailureText.js';

/**
 * 一次手动压缩的结构化结果，即执行端口 `compressNow` 的返回形状；用结构类型以免依赖
 * 任何执行内核类。
 */
export interface CompactTurnResult {
  newHistory: readonly Message[] | null;
  info: ChatCompressionInfo;
}

/** 压缩过程用的瞬时 `system/status` 帧：进入压缩发 `'compacting'`，结束发 `null`。 */
export function buildCompactionStatusMessage(
  sessionId: string,
  status: SDKStatus,
): SDKMessage {
  return {
    type: 'system',
    subtype: 'status',
    status,
    uuid: randomUUID(),
    session_id: sessionId,
  } satisfies SDKMessage;
}

/**
 * 把压缩后的新历史逐条投成 SDK 帧：`compact_boundary` 用 manual 兜底 trigger，
 * user / assistant 走与其它入口相同的拆分投影，其余类型不产帧。
 */
export function projectPostCompactMessages(
  message: Message,
  sessionId: string,
): SDKMessage[] {
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    return [projectCompactBoundaryForSdk(message, sessionId, 'manual')];
  }

  if (message.type === 'user') {
    return splitUserForSdk(message, sessionId);
  }

  if (message.type === 'assistant') {
    return splitAssistantForSdk(message, sessionId);
  }

  return [];
}

/** 压缩成功后回显的本地命令输出帧，与 TUI 的 `/compact` 输出文案一致。 */
export function buildLocalCommandOutputMessage(sessionId: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: '<local-command-stdout>Compacted </local-command-stdout>',
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
    timestamp: new Date(Date.now() + 100).toISOString(),
    isReplay: true,
  } as SDKMessage;
}

/**
 * 压缩轮自己的合成 `result` 终态帧。`num_turns: 0` 是契约：这一轮没有模型对话轮，
 * 混进 `num_turns >= 1` 的真实轮形状会让宿主的轮次记账错位。
 */
export function buildCompactResultMessage(
  sessionId: string,
  result: CompactTurnResult,
  startedAt: number,
): SDKMessage {
  const noOp = result.info.compressionStatus === CompressionStatus.NOOP;
  const success = result.newHistory !== null || noOp;
  let resultText: string;
  if (result.newHistory !== null) {
    resultText = '';
  } else if (noOp) {
    resultText = COMPACT_NOOP_TEXT;
  } else {
    resultText = getCompactErrorText(
      result.info.compressionStatus,
      result.info,
    );
  }
  const usage = cloneUsage();
  usage.input_tokens = result.info.originalTokenCount ?? 0;
  usage.output_tokens = result.info.newTokenCount ?? 0;
  const errorCode = success
    ? undefined
    : (result.info.errorCode ?? result.info.providerCode);
  return {
    type: 'result',
    subtype: success ? 'success' : 'error_during_execution',
    duration_ms: Date.now() - startedAt,
    duration_api_ms: 0,
    is_error: !success,
    num_turns: 0,
    result: resultText,
    stop_reason: null,
    total_cost_usd: 0,
    total_credits: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    ...(success ? {} : { errors: [resultText] }),
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    uuid: randomUUID(),
    session_id: sessionId,
  } as SDKMessage;
}

/** `compressNow` 本体抛错时的合成 `result` 终态帧；中止不携带业务错误码。 */
export function buildCompactThrownErrorResultMessage(
  sessionId: string,
  error: unknown,
  startedAt: number,
): SDKMessage {
  const aborted =
    error instanceof FatalCancellationError || isCancellationError(error);
  const message = aborted
    ? 'Operation aborted'
    : error instanceof Error
      ? error.message
      : String(error);
  const errorCode = aborted ? undefined : getResultErrorCode(error);
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: Date.now() - startedAt,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    total_credits: 0,
    usage: cloneUsage(),
    modelUsage: {},
    permission_denials: [],
    errors: [message],
    ...(aborted ? { terminal_reason: 'aborted_streaming' } : {}),
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    uuid: randomUUID(),
    session_id: sessionId,
  } as SDKMessage;
}
