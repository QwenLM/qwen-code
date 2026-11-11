/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import { captureMcpToolIdentity } from '../../mcp/tools/mcp-tool-history.js';
import type { McpInfo } from '../../mcp/tools/mcp-tool.js';
import type { NonNullableUsage } from '../../protocol/schemas/common.js';
import { normalizeModelToolUseBlock } from '../../protocol/provider/tool-input.js';
import {
  createAssistantMessage,
  modelMessageToAssistantPayload,
} from '../../protocol/transcript/conversions.js';
import type { AssistantMessage } from '../../protocol/transcript/message.js';
import type { NormalizeMessagesForAPIOptions } from '../../protocol/provider/request-converter.js';
import { CUSTOM_PROVIDER_SOURCE } from '../../provider/custom/types.js';
import type {
  ModelContentBlock,
  ModelMessage,
  ModelToolUseBlock,
} from '../../provider/event/modelCompleteEvent.js';

/** 直接提取标准工具块；参数保留校验，MCP 身份仅保存到宿主请求上下文。 */
export function extractToolUseBlocks(
  message: ModelMessage,
  config?: Config,
  capturedMcpIdentities?: Map<string, McpInfo>,
): ModelToolUseBlock[] {
  return message.blocks.flatMap((block) => {
    if (block.type !== 'tool_use') return [];
    const tool = normalizeModelToolUseBlock(block);
    captureMcpToolIdentity(tool, config, capturedMcpIdentities);
    return [tool];
  });
}

/** 标准模型消息按块放入历史宿主，保留原始 index 和末块计量归属。 */
export function splitAssistantMessage(
  message: ModelMessage,
  options: {
    requestId: string;
    responseGroupId: string;
    usage: NonNullableUsage;
    config?: Config;
    capturedMcpIdentities?: Map<string, McpInfo>;
    interrupted: boolean;
    includeEmpty: boolean;
    streamedToolAssistantMessages?: ReadonlyMap<string, AssistantMessage>;
  },
): AssistantMessage[] {
  const indexedBlocks = message.blocks.flatMap((block, index) => [
    { block, index },
  ]);
  if (!indexedBlocks.length) {
    return options.includeEmpty
      ? [
          createAssistantMessage(
            message,
            options.requestId,
            undefined,
            options.usage,
            options.responseGroupId,
          ),
        ]
      : [];
  }
  return indexedBlocks.map(({ block, index }, position) => {
    const isLastBlock = position === indexedBlocks.length - 1;
    const blockMessage: ModelMessage = {
      ...message,
      stopReason: isLastBlock ? message.stopReason : undefined,
      usage: isLastBlock ? message.usage : undefined,
      blocks: [normalizeModelBlockForHistory(block)],
    };
    const identities =
      block.type === 'tool_use' && options.capturedMcpIdentities?.has(block.id)
        ? { [block.id]: options.capturedMcpIdentities.get(block.id)! }
        : undefined;
    const usage = isLastBlock ? options.usage : undefined;
    let assistant =
      block.type === 'tool_use'
        ? options.streamedToolAssistantMessages?.get(block.id)
        : undefined;
    if (assistant) {
      assistant.message = modelMessageToAssistantPayload(
        blockMessage,
        identities,
        usage,
      );
      assistant.requestId = options.requestId;
    } else {
      assistant = createAssistantMessage(
        blockMessage,
        options.requestId,
        identities,
        usage,
        options.responseGroupId,
      );
    }
    if (options.interrupted) assistant.partialStreamIndex = index;
    return assistant;
  });
}

export function normalizeModelBlockForHistory(
  block: ModelContentBlock,
): ModelContentBlock {
  return block.type === 'tool_use'
    ? normalizeModelToolUseBlock(block)
    : structuredClone(block);
}
/** Marks history produced through a custom provider route. */
export function attributeSessionRoute(
  assistantMessage: AssistantMessage,
  servesCustomProvider: boolean,
  projectionOptions: NormalizeMessagesForAPIOptions,
): void {
  if (!servesCustomProvider) return;
  assistantMessage.modelSource = CUSTOM_PROVIDER_SOURCE;
  if (projectionOptions.targetCustomProviderId) {
    assistantMessage.customProviderId = projectionOptions.targetCustomProviderId;
  }
}
