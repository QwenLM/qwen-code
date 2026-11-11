/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话链的手动 `/compact` 执行器。帧序：`status('compacting')` → 压缩 → `status(null)` →
 * 新历史投影 → `Compacted` 本地命令回显 → `num_turns: 0` 的合成 `result`。帧构造器在
 * `compactWireFrames.ts`；执行体是中立端口 `SessionManualCompactor`，本模块不 import
 * 执行内核，也不产 `command_lifecycle` 帧、不碰 turn 记账。
 */

import {
  runLogger,
  uiTelemetryService,
  type ModelStreamUserContent,
  type SDKMessage,
} from '@qwen-code/core';
import {
  buildCompactionStatusMessage,
  buildCompactResultMessage,
  buildCompactThrownErrorResultMessage,
  buildLocalCommandOutputMessage,
  projectPostCompactMessages,
  type CompactTurnResult,
} from './compactWireFrames.js';

/** 手动压缩的入参，`compressNow` 共用的最小子集。 */
export interface SessionManualCompactOptions {
  force?: boolean;
  customInstructions?: string;
  /** SDK 用户消息带来的不透明上下文，随压缩请求透传。 */
  customContext?: Readonly<Record<string, string>>;
}

/**
 * 压缩执行端口：`SessionQueryRunner.compressNow` 满足这个结构类型，本模块不认执行内核类。
 */
export interface SessionManualCompactor {
  compressNow(
    options?: SessionManualCompactOptions,
  ): Promise<CompactTurnResult>;
}

export interface SessionCompactCommandDeps {
  sessionId: string;
  compactor: SessionManualCompactor;
  /** 触发本次 `/compact` 的用户消息上的 custom_context（若有）。 */
  customContext?: Readonly<Record<string, string>>;
}

/**
 * 执行一次手动压缩并产出本轮的全部 wire 帧：成功产边界时先清零 UI 遥测的上次 prompt
 * token 计数（压缩后旧计数已失真），再逐条投影新历史；`newHistory` 为空（NOOP / 失败）
 * 时只发合成 result。生成器永不抛：终态帧就是正常返回路径，调用方据此结算命令生命周期。
 */
export async function* runSessionCompactCommand(
  customInstructions: string | undefined,
  deps: SessionCompactCommandDeps,
): AsyncGenerator<SDKMessage> {
  const { sessionId, compactor, customContext } = deps;

  // 压缩指令正文刻意不打，只记有没有自定义指令。
  runLogger.log('[session-compact] manual compact started', {
    sessionId,
    hasCustomInstructions: customInstructions !== undefined,
  });

  yield buildCompactionStatusMessage(sessionId, 'compacting');

  const startedAt = Date.now();
  try {
    const result = await compactor.compressNow({
      force: true,
      customInstructions,
      ...(customContext !== undefined ? { customContext } : {}),
    });

    yield buildCompactionStatusMessage(sessionId, null);

    if (result.newHistory) {
      runLogger.log('[session-compact] manual compact completed', {
        sessionId,
        compressionStatus: result.info.compressionStatus,
        newHistoryMessages: result.newHistory.length,
        durationMs: Date.now() - startedAt,
      });
      uiTelemetryService.setLastPromptTokenCount(0);
      for (const message of result.newHistory) {
        for (const projected of projectPostCompactMessages(
          message,
          sessionId,
        )) {
          yield projected;
        }
      }
      yield buildLocalCommandOutputMessage(sessionId);
      yield buildCompactResultMessage(sessionId, result, startedAt);
    } else {
      runLogger.log(
        `[session-compact] compact produced no boundary (status=${result.info.compressionStatus}${result.info.blockReason ? `, blockReason=${result.info.blockReason}` : ''})`,
        { sessionId },
      );
      yield buildCompactResultMessage(sessionId, result, startedAt);
    }
  } catch (err) {
    runLogger.log('[session-compact] compact error', {
      sessionId,
      durationMs: Date.now() - startedAt,
      error: err,
    });
    yield buildCompactionStatusMessage(sessionId, null);
    yield buildCompactThrownErrorResultMessage(sessionId, err, startedAt);
  }
}

/**
 * 取内容里最后一个 text 块的文本作为 slash 判定视图。不能拼接全部 text 块——
 * 多块消息里前块的正文会让 `/compact` 匹配不上行首锚点。
 */
export function extractTrailingTextBlock(
  content: ModelStreamUserContent,
): string {
  if (typeof content === 'string') {
    return content;
  }
  const lastBlock = content[content.length - 1];
  if (lastBlock?.type === 'text' && typeof lastBlock.text === 'string') {
    return lastBlock.text;
  }
  return '';
}
