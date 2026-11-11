/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createAttachmentMessage } from '../../attachments/factory.js';
import { parseReasoningEffortLevel } from '../../config/model-values.js';
import type { Message } from '../../protocol/transcript/message.js';
import type { ModelSelection } from '../../provider/model/modelSelection.js';
import { FatalRoutingError } from '../../routing/errors.js';
import {
  createPermissionDeniedSystemMessage,
  REPEATED_TOOL_CALL_TERMINAL_REASON,
} from '../../tool-executor/index.js';
import { toError } from '../../tools/abort-utils.js';
import { raceWithAbortSignal } from '../../utils/abort-race.js';
import { ModelNotFoundError } from '../../utils/httpErrors.js';
import { endModelRequestScope } from '../../model-request/request-scope.js';
import { runLogger } from '../../utils/runLogger.js';
import type { ModelPolicySelectContext } from '../../core/model-policy.js';
import { logLoopFinished, logToolResults } from '../../core/query-diagnostics.js';
import type { Terminal } from '../../core/query-event.js';
import { createContinuationState } from '../../core/query-runtime-state.js';
import { classifyStopFailureError } from '../../core/stream-errors.js';
import {
  resolveEffectiveContextWindow,
  resolveThinkingBudget,
} from '../llm/request-preparation.js';
import type { ConversationContext } from './context.js';
import { waitBeforeContinuation } from './model-settled.js';
import { createUserInterruptionMessage } from './presentation.js';

/** Writes tool results and decides between continuing and finishing. */
export async function handleToolResults(
  ctx: ConversationContext,
): Promise<void> {
  const { state } = ctx;
  const { input } = state;
  const options = input.params;
  const sid = input.sessionId;
  const { promptId } = options;
  const settled = state.flow.settled!;
  const { toolUseBlocks, interrupted, canonicalModelKey, nextTurnCount } =
    settled;
  const stateAfterAssistant = settled.stateAfterAssistant!;
  const streamRecoveryMessages = settled.streamRecoveryMessages;
  const summary = ctx.toolSummary();
  const {
    results: executeResults,
    toolResults,
    historyMessages: toolResultMessages,
    permissionDenials,
    hookStopAttachment,
  } = summary;
  const terminalReason = summary.terminalReason as
    | Terminal['reason']
    | undefined;
  const deniedToolUseIds = new Set<string>(
    permissionDenials.map((denial) => denial.tool_use_id),
  );
  const toolSignal = state.control.toolSignal;
  const cancelSignal = state.control.abort.signal;

  logToolResults({
    sessionId: sid,
    promptId,
    loopId: settled.loopId,
    toolUseBlocks,
    toolResults,
    deniedToolUseIds,
  });
  logLoopFinished({
    sessionId: sid,
    promptId,
    loopId: settled.loopId,
    requestIndex: state.requestIndex,
    level: toolResults.some((result) => result.is_error) ? 'warn' : 'info',
    reason: 'continue_after_tool_results',
    data: {
      tool_use_count: toolUseBlocks.length,
      tool_result_count: toolResults.length,
      error_tool_result_count: toolResults.filter((result) => result.is_error)
        .length,
    },
  });

  const hasUnknownToolOutcomes = summary.hasUnknownOutcomes;

  // Tool results carry contextModifier entries (e.g. Skill activation); apply
  // them in model order so overrides and overlays persist across requests.
  for (const result of executeResults) {
    const modifyContext = result.control.contextModifier;
    if (!modifyContext) continue;
    try {
      state.toolUseContext = modifyContext(state.toolUseContext);
    } catch (error) {
      if (!interrupted) throw error;
      // Preserve settled results before terminating on a post-tool failure.
      settled.terminalInterruption = true;
      interrupted.failure.error = error;
      interrupted.failure.kind = 'terminal';
      break;
    }
  }
  if (interrupted && settled.terminalInterruption) {
    state.control.turnAbort.abort('Model stream interrupted');
  }

  // PostToolUse hooks with continue:false request a stop through an
  // attachment. A failed modifier may have partially changed the context;
  // preserve the failure and settled results without a normal stop.
  const stopAfterInterruptedTools =
    !!interrupted &&
    (settled.terminalInterruption ||
      toolSignal.aborted ||
      hasUnknownToolOutcomes);
  if (hookStopAttachment && !stopAfterInterruptedTools) {
    runLogger.log(
      `[AgentLoop] Hook stopped continuation: ${(hookStopAttachment as { message: string }).message}`,
    );
    for (const toolResultMessage of toolResultMessages) {
      ctx.emit(toolResultMessage);
    }
    if (interrupted) {
      for (const message of streamRecoveryMessages) ctx.emit(message);
      ctx.checkpointTurn([...toolResultMessages, ...streamRecoveryMessages]);
    }
    ctx.emit(createAttachmentMessage(hookStopAttachment));
    await ctx.finish({
      reason: 'end_turn',
      terminalDetail: 'hook_stopped',
      ...ctx.terminalBase(nextTurnCount),
    });
    return;
  }

  const skillModelOverrideError = stopAfterInterruptedTools
    ? undefined
    : await applySkillOverrides(ctx);

  // Reset response text: only the final turn's text matters for after-hook
  state.cumulativeResponseText = '';

  // Permission denial system events for SDK consumers.
  for (const denial of permissionDenials) {
    ctx.emit(createPermissionDeniedSystemMessage(denial, sid));
  }
  for (const toolResultMessage of toolResultMessages) {
    ctx.emit(toolResultMessage);
  }
  if (skillModelOverrideError) {
    if (!interrupted) throw skillModelOverrideError;
    settled.terminalInterruption = true;
    interrupted.failure.error = skillModelOverrideError;
    interrupted.failure.kind = 'terminal';
  }
  const nextMessages: Message[] = [
    ...stateAfterAssistant.messages,
    ...toolResultMessages,
  ];
  state.runtime = { ...stateAfterAssistant, messages: nextMessages };

  if (interrupted) {
    nextMessages.push(...streamRecoveryMessages);
    for (const message of streamRecoveryMessages) ctx.emit(message);
    ctx.checkpointTurn([...toolResultMessages, ...streamRecoveryMessages]);
    if (
      settled.terminalInterruption ||
      toolSignal.aborted ||
      hasUnknownToolOutcomes
    ) {
      await ctx.fireStopFailure(
        classifyStopFailureError(interrupted.failure.error),
        interrupted.failure.kind === 'refusal'
          ? {
              errorDetails: toError(interrupted.failure.error).message,
              lastAssistantMessage: settled.responseText || undefined,
            }
          : { errorDetails: String(interrupted.failure.error) },
        canonicalModelKey,
      );
      await ctx.finish({
        reason:
          interrupted.failure.kind === 'abort' || cancelSignal.aborted
            ? 'abort'
            : 'error',
        ...(interrupted.failure.kind === 'refusal'
          ? { modelStopReason: 'refusal' as const }
          : {}),
        error: toError(interrupted.failure.error),
        ...ctx.terminalBase(nextTurnCount),
      });
      return;
    }
  }

  if (toolSignal.aborted) {
    ctx.emit(createUserInterruptionMessage({ toolUse: true }));
    await ctx.finish({
      reason: 'abort',
      abortKind: 'aborted_tools',
      ...ctx.terminalBase(nextTurnCount),
    });
    return;
  }

  if (terminalReason === REPEATED_TOOL_CALL_TERMINAL_REASON) {
    await ctx.finish({
      reason: REPEATED_TOOL_CALL_TERMINAL_REASON,
      ...ctx.terminalBase(nextTurnCount),
    });
    return;
  }

  // Supplementary messages requested by tools.
  for (const result of executeResults) {
    for (const supplementaryMessage of result.supplementaryMessages) {
      ctx.emit(supplementaryMessage);
      nextMessages.push(supplementaryMessage);
    }
  }

  if (executeResults.some((result) => result.control.stopRequested)) {
    runLogger.log('[AgentLoop] Tool stopped continuation');
    await ctx.finish({
      reason: 'end_turn',
      ...ctx.terminalBase(nextTurnCount),
    });
    return;
  }

  if (interrupted) {
    if (await waitBeforeContinuation(ctx, interrupted.failure.error)) return;
  }

  // The next request carries the tool results; inter-turn input is drained
  // while it is prepared.
  state.runtime = createContinuationState(
    stateAfterAssistant,
    {
      messages: nextMessages,
      pendingUserMessageUuid: undefined,
      stopHookActive: stateAfterAssistant.stopHookActive,
      maxOutputTokensOverride: undefined,
      maxOutputTokensRecoveryCount: 0,
    },
    { reason: 'next_turn' },
  );
  await ctx.request('tool_results');
}

/** Honors Skill model and effort overrides for the following requests. */
async function applySkillOverrides(
  ctx: ConversationContext,
): Promise<Error | undefined> {
  const { state } = ctx;
  const { input } = state;
  const options = input.params;
  const model = state.model!;
  const overrides = state.toolUseContext.skillOverrides;
  const manager = input.config.getModelProviderManager();
  const selectInput = input.selectInput;
  const signal = state.control.abort.signal;
  const agentId = options.isSubagent
    ? (options.agentId ?? options.promptId)
    : undefined;
  let skillModelOverrideError: Error | undefined;

  if (
    overrides?.model &&
    overrides.model !== model.key &&
    overrides.model !== model.selectedSkillModel
  ) {
    const nextModel = overrides.model;
    try {
      const skillInput = {
        purpose: selectInput.purpose,
        overrideSelection: selectInput.overrideSelection,
        ...(selectInput.workdirs ? { workdirs: selectInput.workdirs } : {}),
        parentSelection: options.parentSelection,
        modelResolution: model.resolution,
        adjustment: { kind: 'skill-model', key: nextModel },
        policyPurpose: selectInput.policyPurpose,
        signal,
        request: {
          sessionId: input.sessionId,
          turnIndex: state.requestIndex,
          agentId,
          agentType: options.isSubagent ? options.agentType : undefined,
          cumulativeUsage: state.usage,
        },
      } satisfies ModelPolicySelectContext;
      const skillSelection = await manager.select(skillInput);
      const skillResolution: ModelSelection = {
        model: skillSelection.model,
        config: skillSelection.config,
      };
      model.policyLabels = skillSelection.policy?.labels ?? model.policyLabels;
      model.selectionSource = skillSelection.policy?.overridden
        ? 'sdk-policy'
        : 'explicit';
      runLogger.log(
        `[AgentLoop] Skill model override: ${model.key} → ${skillResolution.model.key}`,
      );
      if (skillResolution.model.key !== model.key) {
        if (state.lifecycle) {
          // Provider-owned queue leases are released by the request scope.
          void endModelRequestScope(input.sessionId, state.lifecycle.requestSetId);
        }
        model.key = skillResolution.model.key;
        input.queryEndState.model = model.key;
      }
      model.resolution = skillResolution;
      if (
        options.resolveSystemPrompt &&
        model.promptResult?.source === 'default'
      ) {
        model.promptResult = await options.resolveSystemPrompt(
          model.key,
          skillResolution.model,
        );
        model.systemPrompt = model.promptResult.blocks;
      }
      model.thinkingBudget = resolveThinkingBudget(model);
      model.contextWindow = resolveEffectiveContextWindow(state, model);
      model.selectedSkillModel = nextModel;
    } catch (error) {
      skillModelOverrideError =
        !input.config.getModelPolicy &&
        (error instanceof ModelNotFoundError ||
          error instanceof FatalRoutingError)
          ? new ModelNotFoundError(
              `Skill model "${nextModel}" is not available in the current model list. Load the model through the model list before activating the Skill.`,
            )
          : toError(error);
    }
  }

  if (!skillModelOverrideError && overrides?.effort) {
    const skillEffort = parseReasoningEffortLevel(overrides.effort);
    if (skillEffort !== undefined) {
      model.resolution = await raceWithAbortSignal(
        manager.select({
          purpose: selectInput.purpose,
          overrideSelection: selectInput.overrideSelection,
          ...(selectInput.workdirs ? { workdirs: selectInput.workdirs } : {}),
          modelResolution: model.resolution,
          adjustment: { kind: 'skill-effort', effort: skillEffort },
          request: {
            sessionId: input.sessionId,
            turnIndex: state.requestIndex,
            agentId,
          },
          signal,
        }),
        signal,
      );
      const previousBudget = model.thinkingBudget;
      model.thinkingBudget = resolveThinkingBudget(model);
      runLogger.log(
        `[AgentLoop] Skill effort override: ${previousBudget} → ${model.thinkingBudget}`,
      );
    }
  }
  return skillModelOverrideError;
}
