/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttachmentExternalContext } from '../../attachments/types.js';
import { normalizeMessagesForAPI } from '../../protocol/index.js';
import type { Message } from '../../protocol/transcript/message.js';
import type { ModelStreamMessage } from '../../provider/modelStreamRequest.js';
import { consumeCommandContinuations } from '../../services/messageQueueManager.js';
import {
  clearInFlightDrainBatch,
  consumeInFlightBatchCancellation,
  isMidTurnConsumableCommand,
  remove as removeFromQueue,
  setInFlightDrainBatch,
  type QueuedCommand,
} from '../../services/messageQueueManager.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import {
  countRequestTokens,
  type RequestTokenInput,
} from '../../utils/request-token-count.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  getRequestBaseHistory,
  type QueryRuntimeState,
} from '../../core/query-runtime-state.js';

/** 集中确定本轮历史边界、请求专用前缀、对话投影和容量计数。 */
export function prepareRequestConversation(
  options: {
    state: QueryRuntimeState;
    pendingTurnMessages: readonly Message[];
    startupMemoryPrefix: readonly Message[];
  } & Omit<RequestTokenInput, 'messages' | 'normalizedMessages'>,
) {
  const { state, pendingTurnMessages, startupMemoryPrefix } = options;
  const projectionOptions = options.projectionOptions ?? {};
  const startedAt = Date.now();
  const history = getRequestBaseHistory(state, pendingTurnMessages);
  const prefixMessages = state.preProjectedMessages ? [] : startupMemoryPrefix;
  let runtimeMessages: readonly Message[];
  let messages: ModelStreamMessage[];
  if (state.preProjectedMessages) {
    // Fork path: pre-projected messages already include memory context.
    const projectedBoundary = Math.min(
      state.preProjectedMessageCount ?? 0,
      history.length,
    );
    messages = [
      ...state.preProjectedMessages,
      ...normalizeMessagesForAPI(
        [...history.slice(projectedBoundary), ...pendingTurnMessages],
        projectionOptions,
      ),
    ];
    // 预投影前缀没有完整的 transcript 对应关系，计数只使用投影结果。
    runtimeMessages = [];
  } else {
    runtimeMessages = [...prefixMessages, ...history, ...pendingTurnMessages];
    // Prefix and history are normalized together so adjacent user messages merge
    // identically in the parent request and every cache-sharing fork. The prefix
    // is ephemeral and never stored in conversation history.
    messages = normalizeMessagesForAPI(runtimeMessages, projectionOptions);
  }
  const messagesBuildDurationMs = Date.now() - startedAt;
  const tokenCount = countRequestTokens({
    model: options.model,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    projectionOptions,
    latestUsage: options.latestUsage,
    messages: runtimeMessages,
    normalizedMessages: messages,
  });
  return {
    history,
    prefixMessages,
    messages,
    tokenCount,
    messagesBuildDurationMs,
  };
}

// ── Mid-turn queue drain helpers ──

export { getMidTurnEligibleCommands as drainMidTurnQueue } from '../../services/messageQueueManager.js';

/**
 * Remove consumed commands from the queue AFTER successful attachment generation.
 */
export function getConsumedMidTurnCommands(
  commands: readonly QueuedCommand[],
): QueuedCommand[] {
  return commands.filter(isMidTurnConsumableCommand);
}

export async function runInFlightDrainBatch<T>(
  commands: QueuedCommand[],
  operation: () => Promise<T>,
): Promise<{ value: T; dropConsumedBatch: boolean }> {
  if (commands.length > 0) {
    setInFlightDrainBatch(commands);
  }

  const settleCancellation = () => {
    const dropConsumedBatch = consumeInFlightBatchCancellation(commands);
    if (dropConsumedBatch) {
      removeFromQueue(commands);
    }
    return dropConsumedBatch;
  };

  try {
    const value = await operation();
    return {
      value,
      dropConsumedBatch: settleCancellation(),
    };
  } catch (error) {
    settleCancellation();
    throw error;
  } finally {
    clearInFlightDrainBatch(commands);
  }
}

export function removeConsumedMidTurnCommands(
  commands: QueuedCommand[],
): QueuedCommand[] {
  if (commands.length === 0) return [];
  const consumed = getConsumedMidTurnCommands(commands);
  if (consumed.length === 0) return [];
  consumeCommandContinuations(consumed);
  removeFromQueue(consumed);
  for (const cmd of consumed) {
    if (cmd.uuid) {
      runLogger.log(`[AgentLoop] Mid-turn command started: uuid=${cmd.uuid}`);
    }
  }
  runLogger.log(
    `[AgentLoop] Mid-turn drain: ${consumed.length} consumed command(s)`,
  );
  return consumed;
}

/**
 * Keep session discovery sources available between tool rounds so new memory
 * and MCP capabilities reach the next model request.
 */
export function buildInterTurnExternalContext(
  config: import('../../config/config.js').Config | undefined,
  toolRegistryOverride?: ToolRegistry,
): AttachmentExternalContext | undefined {
  const mgr = config?.getMemoryContextManager?.();
  const mcpClientManager = config?.getMcpClientManager?.();
  const toolRegistry = toolRegistryOverride ?? config?.getToolRegistry?.();
  const agentRegistry = config?.getAgentRegistry?.();
  if (!mgr && !mcpClientManager && !toolRegistry && !agentRegistry)
    return undefined;
  return {
    ...(mgr ? { memoryContextManager: mgr } : {}),
    ...(mcpClientManager ? { mcpClientManager } : {}),
    ...(toolRegistry ? { toolRegistry } : {}),
    ...(agentRegistry ? { agentRegistry } : {}),
  };
}
