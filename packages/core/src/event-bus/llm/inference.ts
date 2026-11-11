/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelRequestOutcome,
  ModelRequestRunnerEvent,
} from '../../model-request/types.js';
import {
  annotateContextUsageRatio,
  attachThinkingTokenCount,
  getThinkingTokenCount,
} from '../../protocol/provider/usage-converter.js';
import type { ModelStreamRequest } from '../../provider/modelStreamRequest.js';
import type { ModelSelection } from '../../provider/model/modelSelection.js';
import type { ModelPolicyLabels } from '../../core/model-policy.js';
import type { streamProviderRequest } from '../../core/model-request-execution.js';
import {
  getDeliveredModelMessage,
  projectModelUsage,
} from '../../core/model-response-to-query-event.js';
import type { QueryTurn } from '../../core/query-turn.js';
import type { TurnStepInput, TurnStepResult } from '../../core/turn-hooks.js';
import { extractToolUseBlocks } from './result-assembly.js';

/** SDK 宿主显式指定的请求标签优先；其余子 Agent 必须使用稳定类型标签。 */
export function withSubagentBusinessSubTask(
  policyLabels: ModelPolicyLabels | undefined,
  subagentBusinessSubTask: string | undefined,
): ModelPolicyLabels | undefined {
  if (!subagentBusinessSubTask || policyLabels?.subTask?.trim()) {
    return policyLabels;
  }
  return { ...policyLabels, subTask: subagentBusinessSubTask };
}

/** Adapt a native model execution to the turn contract at the host boundary. */
export async function* runModelWithTurnHooks(
  turn: QueryTurn,
  request: ModelStreamRequest,
  messageCount: number,
  executeModel: () => ReturnType<typeof streamProviderRequest>,
): AsyncGenerator<ModelRequestRunnerEvent, ModelRequestOutcome> {
  let outcome: ModelRequestOutcome | undefined;
  const nativeEvents = new Set<ModelRequestRunnerEvent>();
  const stream = turn.step(
    {
      model: request.resolution.model.key,
      effort: request.resolution.config.reasoning?.effort,
      // 保持对话消息的统计口径，不计 system 或工具结果拆分后的消息。
      messageCount,
    },
    async function* (input) {
      const modelStream = executeModel();
      let done = false;
      try {
        for (;;) {
          const item = await modelStream.next();
          if (item.done) {
            done = true;
            outcome = item.value;
            return toTurnStepResult(input, outcome, request.resolution);
          }
          nativeEvents.add(item.value);
          yield item.value;
        }
      } finally {
        if (!done) await modelStream.return(undefined as never);
      }
    },
  );
  let done = false;
  try {
    for (;;) {
      const item = await stream.next();
      if (item.done) {
        done = true;
        if (!outcome)
          throw new Error('turn.step must delegate to the native model step');
        if (nativeEvents.size > 0)
          throw new Error('turn.step must forward every native event');
        turn.stepResult({
          index: item.value.index,
          model: request.resolution.model.key,
          outcome: outcome.kind,
        });
        return outcome;
      }
      if (!nativeEvents.delete(item.value)) {
        throw new Error(
          'turn.step must forward native events once without replacing them',
        );
      }
      yield item.value;
    }
  } finally {
    if (!done) await stream.return(undefined as never);
  }
}

export function toTurnStepResult(
  input: TurnStepInput,
  outcome: ModelRequestOutcome,
  resolution: ModelSelection,
): TurnStepResult {
  const message =
    outcome.kind === 'complete'
      ? outcome.message
      : getDeliveredModelMessage(outcome.message, outcome.delivery);
  const usage = projectModelUsage(message.usage, outcome.requestId);
  if (outcome.kind === 'complete') {
    annotateContextUsageRatio(
      usage,
      resolution.config.context?.contextWindow ??
        resolution.model.limits.maxContextTokens,
    );
  }
  return {
    turnId: input.turnId,
    index: input.index,
    answer: message.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim(),
    toolUses: extractToolUseBlocks(message).map(({ name, input }) => ({
      name,
      input: structuredClone(input),
    })),
    stopReason: message.stopReason ?? null,
    // Thinking usage is non-enumerable and must survive the detached copy.
    usage: attachThinkingTokenCount(
      {
        ...structuredClone(usage),
        model: message.model || input.model,
      },
      getThinkingTokenCount(usage),
    ),
  };
}
