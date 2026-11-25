/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { AnyDeclarativeTool, AnyToolInvocation } from '../tools/tools.js';
import type { ToolCallRequestInfo } from '../tool-executor/types.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import { extractMcpContext } from '../core/coreToolHookTriggers.js';
import {
  PreToolUseHookOutput,
  type HookDecision,
  formatBlockingAttribution,
} from './types.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { HookAttachment } from '../attachments/types.js';
import { EMPTY_SUCCESS_HOOK_RESULT } from './hookAggregator.js';
import { buildSkillHookContext } from '../skills/skillHookContext.js';

/** Subset of HookDecision values relevant for tool-permission decisions. */
type ToolHookDecision = Extract<HookDecision, 'allow' | 'ask' | 'deny'>;

export type HookEvaluationResult =
  | {
      status: 'continue';
      hookDecision?: ToolHookDecision;
      hookSystemMessage?: string;
      modifiedArgs?: Record<string, unknown>;
      newInvocation?: AnyToolInvocation;
      additionalContext?: string;
      /** Prebuilt hook attachments to push into pendingHookAttachments. */
      pendingAttachments?: HookAttachment[];
    }
  | {
      status: 'error';
      error: Error;
      errorType: ToolErrorType;
    };

export async function evaluatePreToolUseHook(
  config: Config,
  tool: AnyDeclarativeTool,
  request: ToolCallRequestInfo,
  invocation: AnyToolInvocation,
  signal?: AbortSignal,
  model?: string,
  context?: ToolUseContext,
): Promise<HookEvaluationResult> {
  const hookSystem = config.getHookSystem();
  if (!hookSystem) {
    return { status: 'continue' };
  }

  const params = invocation.params || {};
  const toolInput: Record<string, unknown> = { ...params };
  const mcpContext = extractMcpContext(invocation, config);
  const skillContext =
    request.name === 'Skill'
      ? buildSkillHookContext(
        config,
        toolInput,
        'model_tool'
      )
      : undefined;

  // 在可变上下文中保存选定目标，后续桥接时继续透传，避免执行时补写冻结对象。
  if (context && skillContext) context.skillHookContext = skillContext;

  const aggregatedResult =
    (await hookSystem.firePreToolUseEvent(
      request.name,
      toolInput,
      request.callId,
      mcpContext,
      request.originalRequestName,
      signal,
      model,
      ...(skillContext ? ([skillContext] as const) : []),
    )) ?? EMPTY_SUCCESS_HOOK_RESULT;

  const beforeOutput = aggregatedResult.finalOutput as
    | PreToolUseHookOutput
    | undefined;

  if (!beforeOutput) {
    return {
      status: 'continue',
      ...(aggregatedResult.pendingAttachments?.length
        ? { pendingAttachments: aggregatedResult.pendingAttachments }
        : {}),
    };
  }

  if (beforeOutput.shouldStopExecution()) {
    return {
      status: 'error',
      error: new Error(
        `Agent execution stopped by hook: ${beforeOutput.getEffectiveReason()}`,
      ),
      errorType: ToolErrorType.STOP_EXECUTION,
    };
  }

  const blockingError = beforeOutput.getBlockingError();
  if (blockingError?.blocked) {
    const attribution = formatBlockingAttribution(blockingError);
    return {
      status: 'error',
      error: new Error(`${attribution}: ${blockingError.reason}`),
      errorType: ToolErrorType.POLICY_VIOLATION,
    };
  }

  let hookDecision: ToolHookDecision | undefined;
  let hookSystemMessage: string | undefined;

  if (beforeOutput.isAskDecision()) {
    hookDecision = 'ask';
    hookSystemMessage = beforeOutput.reason;
  } else if (beforeOutput.decision === 'allow') {
    // Hook explicitly allowed the tool — this should override
    // the permission pipeline's deny decision downstream.
    hookDecision = 'allow';
  }

  let modifiedArgs: Record<string, unknown> | undefined;
  let newInvocation: AnyToolInvocation | undefined;

  if (beforeOutput instanceof PreToolUseHookOutput) {
    const modifiedInput = beforeOutput.getModifiedToolInput();
    if (modifiedInput) {
      modifiedArgs = modifiedInput;

      // Hook 改写参数后重新解析归属，同时保留用户最初请求的 Skill 名称。
      if (context && skillContext)
        context.skillHookContext = buildSkillHookContext(
          config,
          modifiedArgs,
          'model_tool',
          skillContext.requested_skill_name,
        );
      try {
        newInvocation = tool.build(
          modifiedArgs,
          context
        );
      } catch (error) {
        return {
          status: 'error',
          error: new Error(
            `Tool parameter modification by hook failed validation: ${error instanceof Error ? error.message : String(error)}`,
          ),
          errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        };
      }
    }
  }

  const additionalContext = beforeOutput.getAdditionalContext();

  return {
    status: 'continue',
    hookDecision,
    hookSystemMessage,
    modifiedArgs,
    newInvocation,
    additionalContext,
    ...(aggregatedResult.pendingAttachments?.length
      ? { pendingAttachments: aggregatedResult.pendingAttachments }
      : {}),
  };
}
