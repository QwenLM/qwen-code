/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AssistantMessage,
  ContentBlockParam,
  Message,
  UserMessage,
} from '../transcript/message.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';

/**
 * 为 Provider 投影 refusal 历史，同时保留 durable transcript 中的事实。
 *
 * refusal marker 前最后一组 Assistant 消息属于失败的模型响应。该组只保留
 * 已有配对 tool_result 的 tool_use；自然语言、思考块和孤立工具调用不会再次
 * 发送给模型。触发 refusal 的用户输入和更早已经闭合的工具事实保持不变。
 */
export function projectRefusalContext(
  messages: readonly Message[],
): readonly Message[] {
  const projected = [...messages];

  for (
    let markerIndex = projected.length - 1;
    markerIndex >= 0;
    markerIndex--
  ) {
    const marker = projected[markerIndex];
    if (!marker || !isRefusalMarker(marker)) continue;

    const response = findRefusalResponse(projected, markerIndex);
    if (!response) {
      projected.splice(markerIndex, 1);
      continue;
    }

    const resultToolUseIds = collectResultToolUseIds(
      projected,
      response.end + 1,
      markerIndex,
    );
    const retainedToolUseIds = new Set<string>();
    const replacement: Message[] = [];

    for (let index = response.start; index <= response.end; index++) {
      const message = projected[index];
      if (message?.type !== 'assistant') continue;
      const toolUses = message.message.content.filter(
        (block): block is ModelToolUseBlock =>
          block.type === 'tool_use' && resultToolUseIds.has(block.id),
      );
      if (toolUses.length === 0) continue;
      for (const toolUse of toolUses) retainedToolUseIds.add(toolUse.id);
      replacement.push({
        ...message,
        message: {
          ...message.message,
          content: toolUses,
        },
      });
    }

    for (let index = response.end + 1; index < markerIndex; index++) {
      const message = projected[index];
      if (!message) continue;
      if (message.type !== 'user' || !isToolResultMessage(message)) {
        replacement.push(message);
        continue;
      }

      const retainedContent = message.message.content.filter(
        (block) =>
          block.type !== 'tool_result' ||
          retainedToolUseIds.has(block.tool_use_id),
      );
      if (retainedContent.length === 0) continue;
      replacement.push(cloneToolResultMessage(message, retainedContent));
    }

    projected.splice(
      response.start,
      markerIndex - response.start + 1,
      ...replacement,
    );
    markerIndex = response.start;
  }

  return projected;
}

function isRefusalMarker(message: Message): message is AssistantMessage {
  return (
    message.type === 'assistant' && message.isContentFilteredMessage === true
  );
}

function findRefusalResponse(
  messages: readonly Message[],
  markerIndex: number,
): { start: number; end: number } | undefined {
  let end = markerIndex - 1;
  while (end >= 0 && isToolResultMessage(messages[end])) end--;
  if (end < 0 || messages[end]?.type !== 'assistant') return undefined;

  let start = end;
  while (start > 0 && messages[start - 1]?.type === 'assistant') start--;
  return { start, end };
}

function collectResultToolUseIds(
  messages: readonly Message[],
  start: number,
  end: number,
): Set<string> {
  const result = new Set<string>();
  for (let index = start; index < end; index++) {
    const message = messages[index];
    if (!isToolResultMessage(message)) continue;
    for (const block of message.message.content) {
      if (block.type === 'tool_result') result.add(block.tool_use_id);
    }
  }
  return result;
}

function isToolResultMessage(
  message: Message | undefined,
): message is UserMessage & { message: { content: ContentBlockParam[] } } {
  return (
    message?.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content.some((block) => block.type === 'tool_result')
  );
}

function cloneToolResultMessage(
  message: UserMessage & { message: { content: ContentBlockParam[] } },
  content: ContentBlockParam[],
): UserMessage {
  if (content.length === message.message.content.length) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content,
    },
  };
}
