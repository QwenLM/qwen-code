/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { createAttachmentMessage } from '../../attachments/factory.js';
import { drainHookOutputAttachments } from '../../attachments/generators/hook-generators.js';
import { HookEventName, truncateHookOutput } from '../../hooks/types.js';
import {
  createUserMessage,
  modelInputToTranscriptBlock,
} from '../../protocol/transcript/conversions.js';
import type { Message } from '../../protocol/transcript/message.js';






import { runLogger } from '../../utils/runLogger.js';
import {
  businessInfoContext,
  getBusinessInfoFromContext,
  getRequestSetIdFromContext,
} from '../../utils/sessionIdContext.js';
import { createToolFileStateCache } from '../../utils/fileStateCache.js';
import type { ToolUseContext } from '../../tools/tool-types.js';
import {
  AgentLifecycleState,
  createQueryBusinessInfo,
} from '../../core/agent-lifecycle-state.js';
import { logInputPromptSubmitted, logTurnStarted } from '../../core/query-diagnostics.js';
import {
  createHistoryOnlyRuntimeState,
  createInitialQueryRuntimeState,
} from '../../core/query-runtime-state.js';
import type { QueryState } from '../state.js';
import type { ConversationContext } from './context.js';

/** BeforeAgent, the user message and query setup; then the first request. */
export async function handleSubmitted(ctx: ConversationContext): Promise<void> {
  const { state } = ctx;
  const { input } = state;
  const options = input.params;
  const { prompt, promptId, permissionMode, attachmentCtx, isSubagent } =
    options;
  const sid = input.sessionId;
  const promptText = input.promptText;

  runLogger.debug(
    `[AgentLoop] query() start: sessionId=${sid}, ctxRequestSetId=${getRequestSetIdFromContext()}, isSubagent=${isSubagent}`,
  );

  const requestedModel = input.queryEndState.model;
  const queryBusinessInfo = isSubagent
    ? (options.parentBusinessInfo ?? getBusinessInfoFromContext())
    : (options.businessInfo ??
      (await createQueryBusinessInfo(
        sid,
        promptText,
        options.userMessage?.requestSetId ??
          options.preallocatedRequestSetId ??
          randomUUID(),
        options.querySource,
        requestedModel,
      )));
  state.businessInfo = queryBusinessInfo;
  const priorHistory = options.messages ? [...options.messages] : [];

  logInputPromptSubmitted({
    sessionId: sid,
    promptId,
    prompt: promptText,
    isMeta: options.isMeta === true,
    isSubagent: isSubagent === true,
    skipInitialUserMessage: options.skipInitialUserMessage === true,
    originKind: undefined,
  });
  logTurnStarted({
    sessionId: sid,
    promptId,
    model: requestedModel,
    promptLength: promptText.length,
    historyLength: priorHistory.length,
    skipInitialUserMessage: options.skipInitialUserMessage === true,
    skipBeforeHook: options.skipBeforeHook === true,
    isSubagent: isSubagent === true,
  });

  if (!options.skipInitialUserMessage) {
    const userMessage = createUserMessage(
      typeof prompt === 'string'
        ? prompt
        : prompt.map(modelInputToTranscriptBlock),
      {
        uuid: options.userMessage?.uuid,
        timestamp: options.userMessage?.timestamp,
        origin: { kind: 'human' },
        permissionMode,
        isMeta: options.isMeta,
        requestSetId:
          options.userMessage?.requestSetId ?? options.preallocatedRequestSetId,
        businessModelKey: queryBusinessInfo?.model_key,
        businessIdentity: queryBusinessInfo
          ? {
              product: queryBusinessInfo.product,
              type: queryBusinessInfo.type,
              id: queryBusinessInfo.id,
              model_key: queryBusinessInfo.model_key,
            }
          : undefined,
        humanInput: { text: promptText, mode: 'prompt' },
      },
    );
    userMessage.promptId = promptId;
    if (options.userMessage?.isDelegatedTask) {
      userMessage.isDelegatedTask = true;
    }
    state.userMessage = userMessage;
  }
  const userMessage = state.userMessage;

  // BeforeAgent fires before the user message is delivered so block can erase it.
  const hookCoordinator = options.hookCoordinator;
  if (hookCoordinator && !options.skipBeforeHook) {
    const fireBefore = () =>
      hookCoordinator.fireBefore(
        promptId,
        promptText,
        undefined,
        options.userMessage?.requestSetId ?? options.preallocatedRequestSetId,
      );
    const hookResult = await (queryBusinessInfo
      ? businessInfoContext.run(queryBusinessInfo, fireBefore)
      : fireBefore());
    const beforeHookAttachments = hookResult?.pendingAttachments ?? [];
    if (hookResult?.blocked) {
      for (const att of beforeHookAttachments) {
        ctx.emit(createAttachmentMessage(att));
      }
      // Block: userMessage never enters history
      await ctx.finish({
        reason: 'error',
        error: new Error('Agent execution blocked by hook'),
        ...ctx.terminalBase(0),
      });
      return;
    }
    if (hookResult?.stopped) {
      // Stop: preserve user message but don't run query
      if (userMessage) ctx.emit(userMessage);
      for (const att of beforeHookAttachments) {
        ctx.emit(createAttachmentMessage(att));
      }
      const stopMsg = hookResult.stopReason
        ? `Operation stopped by hook: ${hookResult.stopReason}`
        : 'Operation stopped by hook';
      ctx.emit(createUserMessage(stopMsg, { isMeta: true }));
      await ctx.finish({
        reason: 'end_turn',
        terminalDetail: 'hook_stopped',
        ...(hookResult.stopReason
          ? { hookStopReason: hookResult.stopReason }
          : {}),
        ...ctx.terminalBase(0),
      });
      return;
    }
    if (hookResult?.sessionTitle && input.config.persistSessionTitle) {
      await input.config.persistSessionTitle(hookResult.sessionTitle);
    }
    // stdout reaches model only for SessionStart/UserPromptSubmit events
    if (
      hookResult?.stdoutForModel &&
      !hookResult?.suppressOutput &&
      attachmentCtx
    ) {
      attachmentCtx.pendingHookOutputs.push({
        hookEventName: HookEventName.UserPromptSubmit,
        output: hookResult.stdoutForModel,
        sourceType: 'stdout',
      });
    }
    if (hookResult?.additionalContext && attachmentCtx) {
      attachmentCtx.pendingHookOutputs.push({
        hookEventName: HookEventName.UserPromptSubmit,
        output: truncateHookOutput(hookResult.additionalContext),
        sourceType: 'additionalContext',
      });
    }
    if (beforeHookAttachments.length > 0 && attachmentCtx) {
      attachmentCtx.pendingHookAttachments.push(...beforeHookAttachments);
    }
  }

  await input.turn.start(promptText);

  if (userMessage) ctx.emit(userMessage);
  for (const attachment of options.initialInputAttachments ?? []) {
    ctx.emit(attachment);
  }

  // Materialize synchronous submit-hook context before the runtime state is
  // created. The attachment stays after the user's input in the transcript,
  // while normalizeMessagesForAPI() projects it ahead of the prompt.
  const initialHookMessages: Message[] = [];
  if (
    attachmentCtx &&
    (attachmentCtx.pendingHookOutputs.length > 0 ||
      attachmentCtx.pendingHookAttachments.length > 0)
  ) {
    for (const attachment of drainHookOutputAttachments(attachmentCtx)) {
      const message = createAttachmentMessage(attachment);
      initialHookMessages.push(message);
      ctx.emit(message);
    }
  }

  // The selected output limit is applied by Llm with the first selection.
  state.runtime = options.skipInitialUserMessage
    ? createHistoryOnlyRuntimeState({
        history: [...priorHistory, ...initialHookMessages],
        preProjectedMessages: options.preProjectedMessages,
        preProjectedMessageCount: options.preProjectedMessages
          ? priorHistory.length
          : undefined,
        stopHookActive: options.stopHookActive,
      })
    : createInitialQueryRuntimeState({
        history: priorHistory,
        userMessage: userMessage!,
        messagesAfterUser: [
          ...(options.initialInputAttachments ?? []),
          ...initialHookMessages,
        ],
        preProjectedMessages: options.preProjectedMessages,
        preProjectedMessageCount: options.preProjectedMessages
          ? priorHistory.length
          : undefined,
        stopHookActive: options.stopHookActive,
      });

  // Loop-level ToolUseContext — carries skill overrides (model, effort) and
  // skill permission overlays (allowedTools) across requests of this query.
  let toolUseContext: ToolUseContext = {
    queryLifecycle: state.control.queryLifecycle,
    signal: state.control.toolSignal,
    fileReadState:
      attachmentCtx?.fileReadState ??
      options.fileReadState ??
      createToolFileStateCache(),
    abortController: state.control.turnAbort,
    isWorkflowAgent: options.isWorkflowAgent,
    pendingHookOutputs: attachmentCtx?.pendingHookOutputs,
    pendingHookAttachments: attachmentCtx?.pendingHookAttachments,
    ...(options.allowedTools?.length
      ? {
          skillPermissionOverlay: {
            allowedToolPatterns: [...options.allowedTools],
          },
        }
      : {}),
  };

  runLogger.debug(
    `[AgentLoop] subagent params: isSubagent=${isSubagent}, parentBusinessInfo=${JSON.stringify(options.parentBusinessInfo)}, promptId=${promptId}, parentRequestSetId=${options.parentRequestSetId}`,
  );
  if (isSubagent) {
    runLogger.debug(
      `[AgentLoop] AsyncLocalStorage check: ctxRequestSetId=${getRequestSetIdFromContext()}, ctxBusinessInfo=${JSON.stringify(getBusinessInfoFromContext())}`,
    );
  }
  const lifecycle = isSubagent
    ? await AgentLifecycleState.createForSubagent(
        sid,
        promptText,
        options.parentBusinessInfo,
        promptId,
        options.parentRequestSetId,
        options.agentType,
      )
    : await AgentLifecycleState.create(
        sid,
        promptText,
        options.querySource,
        options.userMessage?.requestSetId,
        options.preallocatedRequestSetId,
        queryBusinessInfo,
      );
  state.lifecycle = lifecycle;
  runLogger.debug(
    `[AgentLoop] lifecycle initialized: requestSetId=${lifecycle.requestSetId}, ` +
      `agentType=${isSubagent ? 'sub' : 'main'}, ` +
      `businessInfo=${JSON.stringify(lifecycle.businessInfo)}`,
  );

  input.queryEndState.requestSetId = lifecycle.requestSetId;
  input.queryEndState.businessId = lifecycle.businessInfo.id || undefined;
  lifecycle.changeBusinessState();
  if (!isSubagent && options.onBusinessContextReady) {
    try {
      options.onBusinessContextReady({
        sessionId: sid,
        requestSetId: lifecycle.requestSetId,
        businessId: lifecycle.businessInfo.id,
      });
    } catch (error) {
      runLogger.debug('[AgentLoop] onBusinessContextReady failed:', error);
    }
  }
  toolUseContext = {
    ...toolUseContext,
    config: input.config,
    sessionId: sid,
    parentRequestSetId: lifecycle.requestSetId,
    parentBusinessInfo: lifecycle.businessInfo,
    customContext: options.customContext,
  };
  state.toolUseContext = toolUseContext;

  await ctx.request('initial');
}

/**
 * Marks the task as running once the model selection exists; the terminal
 * report keys off this so a run that never selected a model reports nothing.
 */
export function markTaskStarted(state: QueryState): void {
  if (state.task.started || !state.lifecycle || !state.model) return;
  state.task.started = true;
}
