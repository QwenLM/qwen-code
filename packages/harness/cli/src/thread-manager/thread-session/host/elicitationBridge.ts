/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP elicitation 桥：把 `elicit` 反向请求接到宿主的 `elicitation` 通道，并把
 * 完成事实报成 `elicitationCompleted` 通知。
 *
 * 只产产品级语义：不构造帧，不认识 subtype 与 request_id，信封字段由宿主编解码器
 * 补齐。不装这座桥时，MCP 的 ElicitRequest 会回落到 `{action:'cancel'}`，所有需要
 * 用户补充输入的授权流一律静默取消。
 */

import { OutputFormat, runLogger, type Config } from '@qwen-code/core';
import type { ThreadHostRequests, ThreadNotice } from '../contract/hostContext.js';

export interface ElicitationBridgeParams {
  readonly config: Config;
  /** 会话标识；信封的 session_id 由宿主补。 */
  readonly sessionId: string;
  readonly emitNotice: (notice: ThreadNotice) => void;
  /** 宿主的 elicitation 反向请求；帧与 request_id 关联归宿主。 */
  readonly elicit: ThreadHostRequests['elicit'];
}

/**
 * 把 elicitation 桥装到本会话的 McpElicitationHost 实例上：不是进程级槽，多会话天然隔离。
 * 只在 stream-json 输出下安装——装不装桥决定授权流是「问上游」还是「就地 cancel」。
 */
export function installElicitationBridge(
  params: ElicitationBridgeParams,
): void {
  const { config, sessionId, emitNotice, elicit } = params;
  if (config.getOutputFormat() !== OutputFormat.STREAM_JSON) return;

  config.getElicitationHost().setElicitationBridge({
    requestElicitation: async (serverName, elicitationParams, signal) => {
      // payload 字段名是上游协议定义的形状，会话只透传；`subtype` 信封归宿主。
      const payload: Record<string, unknown> = {
        mcp_server_name: serverName,
        message: elicitationParams.message,
      };
      // 逐字段 `in` + 真值判定：SDK 侧按字段是否存在分支，`??` 或解构默认值会把
      // 「显式传了空串」和「没传」混成一件事。
      if ('mode' in elicitationParams && elicitationParams.mode) {
        payload['mode'] = elicitationParams.mode;
      }
      if ('url' in elicitationParams && elicitationParams.url) {
        payload['url'] = elicitationParams.url;
      }
      if (
        'elicitationId' in elicitationParams &&
        elicitationParams.elicitationId
      ) {
        payload['elicitation_id'] = elicitationParams.elicitationId;
      }
      if (
        'requestedSchema' in elicitationParams &&
        elicitationParams.requestedSchema !== undefined
      ) {
        payload['requested_schema'] = elicitationParams.requestedSchema;
      }

      // message / requested_schema 正文刻意不打：那是给终端用户看的提示内容。
      runLogger.log('[thread-session] elicitation requested', {
        sessionId,
        serverName,
        elicitationId: payload['elicitation_id'],
        mode: payload['mode'],
      });

      const response = await elicit(payload, { signal });
      const responseRecord =
        response && typeof response === 'object'
          ? (response as Record<string, unknown>)
          : undefined;
      const action = responseRecord?.['action'];
      if (action === 'accept' || action === 'decline' || action === 'cancel') {
        const rawContent = responseRecord?.['content'];
        // content 只在 accept 且确实是个对象时透传；decline / cancel 带内容一律丢弃。
        const content =
          action === 'accept' &&
          rawContent !== null &&
          rawContent !== undefined &&
          typeof rawContent === 'object'
            ? (rawContent as Record<
                string,
                string | number | boolean | string[]
              >)
            : undefined;
        runLogger.log('[thread-session] elicitation settled', {
          sessionId,
          serverName,
          action,
          hasContent: content !== undefined,
        });
        return content === undefined ? { action } : { action, content };
      }
      runLogger.log('[thread-session] elicitation settled', {
        sessionId,
        serverName,
        action: 'cancel',
        unrecognizedResponse: true,
      });
      return { action: 'cancel' as const };
    },

    notifyElicitationComplete: (serverName, elicitationId) => {
      runLogger.log('[thread-session] elicitation complete notified', {
        sessionId,
        serverName,
        elicitationId,
      });
      // 只产语义通知：`elicitation_complete` 的帧形由宿主编解码器补齐。
      emitNotice({
        kind: 'elicitationCompleted',
        payload: { mcp_server_name: serverName, elicitation_id: elicitationId },
      });
    },
  });
}
