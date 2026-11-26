/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `session/load` 的历史回放：把已落盘 transcript 的消息投影成 ACP session updates。
 *
 * ThreadManager 负责把历史灌回执行内核；protocol 要求的历史回显是 ACP 专属，留在
 * 这里。回放必须在 `session/load` 的 JSON-RPC 响应之前完成。
 */

import type * as acp from '@agentclientprotocol/sdk';
import {
  getAssistantTextBlocks,
  getUserTextBlocks,
  isMeaningfulUserPromptMessage,
  isToolResultUserMessage,
  type Config,
  type Message,
} from '@qwen-code/core';
import { projectToolCall, type RuntimeToolResult } from './toolProjection.js';

export interface AcpHistoryReplayParams {
  readonly messages: readonly Message[];
  readonly config: Config;
  readonly supportsTerminalOutput: boolean;
  readonly sendUpdate: (update: acp.SessionUpdate) => Promise<void>;
  readonly rememberToolName: (toolCallId: string, name: string) => void;
}

export async function replayAcpHistory(
  params: AcpHistoryReplayParams,
): Promise<void> {
  const { messages, config } = params;
  const toolResultMap = buildToolResultMap(messages);
  const toolRegistry = config.getToolRegistry();

  for (const message of messages) {
    if (isMeaningfulUserPromptMessage(message)) {
      const text = getUserTextBlocks(message).join('\n').trim();
      if (!text) {
        continue;
      }
      await params.sendUpdate({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        messageId: message.uuid,
      });
      continue;
    }

    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'thinking' && block.thinking.trim()) {
          await params.sendUpdate({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: block.thinking },
            messageId: message.uuid,
          });
        }
      }

      const text = getAssistantTextBlocks(message).join('').trim();
      if (text) {
        await params.sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
          messageId: message.uuid,
        });
      }

      for (const block of message.message.content) {
        if (block.type !== 'tool_use') {
          continue;
        }
        const result = toolResultMap.get(block.id);
        const tool = toolRegistry.getTool(block.name);
        params.rememberToolName(block.id, block.name);
        await params.sendUpdate({
          sessionUpdate: 'tool_call',
          ...projectToolCall({
            toolCallId: block.id,
            name: block.name,
            input: block.input,
            kind: tool?.kind,
            result,
            supportsTerminalOutput: params.supportsTerminalOutput,
          }),
        });
      }
      continue;
    }

    if (isToolResultUserMessage(message)) {
      continue;
    }
  }
}

function buildToolResultMap(
  messages: readonly Message[],
): Map<string, RuntimeToolResult> {
  const toolResultMap = new Map<string, RuntimeToolResult>();

  for (const message of messages) {
    if (
      message.type !== 'user' ||
      typeof message.message.content === 'string'
    ) {
      continue;
    }

    const toolResultBlocks = message.message.content.filter(
      (block): block is typeof block & { type: 'tool_result' } =>
        block.type === 'tool_result',
    );
    if (toolResultBlocks.length === 0) {
      continue;
    }

    const displays =
      toolResultBlocks.length === 1
        ? [message.toolUseResult]
        : Array.isArray(message.toolUseResult)
          ? message.toolUseResult
          : [];

    for (let index = 0; index < toolResultBlocks.length; index++) {
      const block = toolResultBlocks[index];
      const display = displays[index];
      let filePath: string | undefined;
      if (display && typeof display === 'object') {
        if ('filePath' in display && typeof display.filePath === 'string') {
          filePath = display.filePath;
        } else if (
          'file_path' in display &&
          typeof display.file_path === 'string'
        ) {
          filePath = display.file_path;
        }
      }

      toolResultMap.set(block.tool_use_id, {
        display,
        isError: block.is_error === true,
        filePath,
      });
    }
  }

  return toolResultMap;
}
