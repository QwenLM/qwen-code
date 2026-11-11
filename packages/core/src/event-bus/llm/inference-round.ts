/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { captureMcpToolIdentity } from '../../mcp/tools/mcp-tool-history.js';
import { mergeModelRequestProgress } from '../../model-request/request-scope.js';
import type { ModelRequestOutcome } from '../../model-request/types.js';
import { createAssistantMessage } from '../../protocol/transcript/conversions.js';
import type { AssistantMessage } from '../../protocol/transcript/message.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import { applyBusinessSubTask } from '../../qoder/business-info.js';
import { runLogger } from '../../utils/runLogger.js';
import { projectModelUsage } from '../../core/model-response-to-query-event.js';
import { logToolRequested } from '../../core/query-diagnostics.js';
import { resolveSubagentBusinessSubTask } from '../../core/subagent-business-subtask.js';
import type { LlmRoundContext, AssembledRequest } from './request-preparation.js';
import {
  buildModelPrompt,
  streamProviderRequest,
  taskIdForQuerySource,
} from '../../core/model-request-execution.js';
import { uiTelemetryService } from '../../services/session-stats.js';
import { runModelWithTurnHooks, withSubagentBusinessSubTask } from './inference.js';
import { yieldToEventLoop } from '../handler-support.js';

export interface InferenceResult {
  outcome:
    | { kind: 'complete'; value: Extract<ModelRequestOutcome, { kind: 'complete' }> }
    | {
        kind: 'interrupted';
        value: Extract<ModelRequestOutcome, { kind: 'interrupted' }>;
      }
    | { kind: 'error'; error: unknown };
  dispatchedToolUseBlocks: ModelToolUseBlock[];
  /** Assistant parts of the dispatched tools, for failures that keep them. */
  dispatchedAssistantMessages: AssistantMessage[];
  iterationHadThought: boolean;
}

export interface ToolUseDispatcher {
  (block: ModelToolUseBlock, responseId: string, assistantMessageUuid?: string): void;
}

export async function runInference(
  ctx: LlmRoundContext,
  assembled: AssembledRequest,
  dispatchToolUse: ToolUseDispatcher,
): Promise<InferenceResult> {
  const { state, signal } = ctx;
  const { input } = state;
  const options = input.params;
  const lifecycle = state.lifecycle!;
  const sid = input.sessionId;
  const promptId = options.promptId;
  const { model, conversation, modelRequestId, responseGroupId } = assembled;
  const isSubagent = options.isSubagent;
  const requestIndex = ctx.round.requestIndex;
  const dispatchedToolUseBlocks: ModelToolUseBlock[] = [];
  const dispatchedAssistantMessages: AssistantMessage[] = [];
  let iterationHadThought = false;

  try {
    const requestPolicyLabels = withSubagentBusinessSubTask(
      model.policyLabels,
      isSubagent ? resolveSubagentBusinessSubTask(options.agentType) : undefined,
    );
    const requestBusiness = lifecycle.businessInfo
      ? applyBusinessSubTask(
          lifecycle.businessInfo,
          options.querySource,
          requestPolicyLabels?.subTask,
        )
      : undefined;
    const taskId =
      taskIdForQuerySource(options.querySource) ??
      (requestBusiness?.type === 'sec_scan' ? requestBusiness.type : undefined);
    const patches = isSubagent === true ? undefined : options.modelRequestPatches;
    const workdirs = input.selectInput.workdirs;
    // 单轮请求在这里完成装配，之后原样交给 Provider。
    const request = {
      resolution: model.resolution,
      prompt: buildModelPrompt(model.resolution, {
        system: model.systemPrompt,
        messages: conversation.messages,
        tools: assembled.toolSchemas,
        toolChoice: options.toolChoice,
        skipCacheWrite: options.skipCacheWrite,
      }),
      control: { signal },
      qoder: {
        identity: {
          sessionId: sid,
          sourceSessionId: options.sourceSessionId,
          requestSetId: lifecycle.requestSetId,
          requestId: modelRequestId,
        },
        ...(workdirs ? { workdirs } : {}),
        taskRouting: { taskId, policyTaskId: requestPolicyLabels?.taskId },
        ...(options.customContext !== undefined
          ? { customContext: options.customContext }
          : {}),
        ...(assembled.extraHeaders !== undefined
          ? { extraHeaders: assembled.extraHeaders }
          : {}),
        ...(patches && Object.keys(patches).length > 0 ? { patches } : {}),
        ...(requestBusiness !== undefined ? { business: requestBusiness } : {}),
      },
    };
    const diagnostic = {
      loopId: assembled.loopId,
      requestIndex,
      requestMessageCount: conversation.messages.length,
      toolSchemaCount: assembled.toolSchemas.length,
      taskId: lifecycle.requestSetId,
      isSubagent: isSubagent === true,
      requestMessagesBuildDurationMs: assembled.requestMessagesBuildDurationMs,
      userMessageTiming:
        !isSubagent && options.userMessageSubmittedAtMs !== undefined
          ? {
              submittedAtMs: options.userMessageSubmittedAtMs,
              extra: options.extra,
            }
          : undefined,
      onCompleted: options.onModelRequestCompleted,
      onFinished: options.onModelRequestFinished,
      onObservation: options.onModelRequestObservation,
      isWorkflowAgent: options.isWorkflowAgent,
    };
    const gen = mergeModelRequestProgress(
      {
        sessionId: sid,
        requestSetId: lifecycle.requestSetId,
        requestId: modelRequestId,
      },
      runModelWithTurnHooks(
        input.turn,
        request,
        diagnostic.requestMessageCount,
        () =>
          streamProviderRequest(input.config, request, {
            diagnostic,
            // Only the foreground conversation owns the session context meter.
            onMainPromptTokenCount:
              !diagnostic.isSubagent && options.querySource !== 'side_question'
                ? (count) => uiTelemetryService.setLastPromptTokenCount(count)
                : undefined,
          }),
      ),
    );

    let requestStreamDone = false;
    try {
      for (;;) {
        const iterResult = await gen.next();
        if (iterResult.done) {
          requestStreamDone = true;
          const outcome = iterResult.value;
          return {
            outcome:
              outcome.kind === 'interrupted'
                ? { kind: 'interrupted', value: outcome }
                : { kind: 'complete', value: outcome },
            dispatchedToolUseBlocks,
            dispatchedAssistantMessages,
            iterationHadThought,
          };
        }
        const event = iterResult.value;
        const toolBlock =
          event.type === 'assistant_block' &&
          event.message.blocks[0]?.type === 'tool_use'
            ? event.message.blocks[0]
            : undefined;
        if (event.type === 'assistant_block' && toolBlock) {
          const identity = captureMcpToolIdentity(
            toolBlock,
            input.config,
            assembled.capturedMcpIdentities,
          );
          if (identity) event.mcpToolIdentities = { [toolBlock.id]: identity };
        }
        ctx.emit(event);
        if (
          event.type === 'stream_event' &&
          event.event.type === 'content_block_delta' &&
          event.event.delta.type === 'thinking_delta'
        ) {
          iterationHadThought = true;
        }
        if (event.type === 'assistant_block' && toolBlock) {
          logToolRequested({
            sessionId: sid,
            promptId,
            loopId: assembled.loopId,
            block: toolBlock,
          });
          // The block is delivered first; execution then overlaps the rest
          // of the model stream.
          if (options.toolExecutor) {
            const blockRequestId = event.requestId ?? modelRequestId;
            const streamedAssistant = createAssistantMessage(
              { ...event.message, stopReason: undefined },
              event.requestId,
              event.mcpToolIdentities,
              projectModelUsage(event.message.usage, blockRequestId),
              responseGroupId,
            );
            dispatchToolUse(toolBlock, blockRequestId, streamedAssistant.uuid);
            runLogger.log(
              `[AgentLoop] Streaming: dispatched tool_use block "${toolBlock.name}" (id=${toolBlock.id})`,
            );
            dispatchedToolUseBlocks.push(toolBlock);
            dispatchedAssistantMessages.push(streamedAssistant);
          }
        }
        await yieldToEventLoop();
      }
    } finally {
      if (!requestStreamDone) {
        try {
          await gen.return(undefined as never);
        } catch (error) {
          runLogger.debug('[AgentLoop] Failed to close model request:', error);
        }
      }
    }
  } catch (error) {
    return {
      outcome: { kind: 'error', error },
      dispatchedToolUseBlocks,
      dispatchedAssistantMessages,
      iterationHadThought,
    };
  }
}
