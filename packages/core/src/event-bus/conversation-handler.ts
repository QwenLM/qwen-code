/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { normalizeMessagesForAPI } from '../protocol/index.js';
import type { Message } from '../protocol/transcript/message.js';
import { reportBusinessFinish } from '../qoder/business-finish.js';
import { endModelRequestScope } from '../model-request/request-scope.js';





import { isCancellationError } from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';
import { businessInfoContext } from '../utils/sessionIdContext.js';
import { logTurnFinished } from '../core/query-diagnostics.js';
import type { Terminal } from '../core/query-event.js';
import type { QueryEventBus } from './bus.js';
import type { AnyBusEvent, BusEvent } from './events.js';
import { emitOutput, publishFor } from './handler-support.js';
import type {
  ConversationContext,
  FinishOptions,
} from './conversation/context.js';
import {
  finishAbortedAfterAssistant,
  finishAbortStreamingAfterTools,
  finishRefusal,
  finishRequestError,
  handleLlmSettled,
  needsToolSettlement,
  writePrepared,
} from './conversation/model-settled.js';
import { fireStopFailureSafely } from './conversation/presentation.js';
import { handleSubmitted, markTaskStarted } from './conversation/submit.js';
import { handleToolResults } from './conversation/tools-settled.js';
import {
  currentRound,
  type QueryState,
  type QueryStateStore,
  type ToolContinuation,
} from './state.js';

/**
 * The only writer of query context and the only decision maker: writes model
 * and tool results in event order, then retries, continues or finishes.
 */
export class ConversationHandler {
  constructor(
    private readonly bus: QueryEventBus,
    private readonly store: QueryStateStore,
  ) {}

  register(): () => void {
    return this.bus.subscribe(
      'conversation',
      [
        'query.submitted',
        'llm.settled',
        'tool.settled',
        'query.cancelled',
        'handler.failed',
      ],
      (event) => this.handle(event),
    );
  }

  private async handle(event: AnyBusEvent): Promise<void> {
    const state = this.store.get(event.queryId);
    if (!state || state.terminal) return;
    try {
      await state.input.runInContext(() => this.dispatch(state, event));
    } catch (error) {
      if (state.flow.failure || state.flow.finishing) {
        runLogger.warn('[AgentLoop] Conversation failed again:', error);
        return;
      }
      state.flow.failure = { error };
      throw error;
    }
  }

  private async dispatch(state: QueryState, event: AnyBusEvent): Promise<void> {
    const ctx = this.context(state);
    switch (event.type) {
      case 'query.submitted':
        await handleSubmitted(ctx);
        return;
      case 'llm.settled':
        await this.onLlmSettled(ctx, event);
        return;
      case 'tool.settled':
        await this.onToolSettled(ctx, event);
        return;
      case 'query.cancelled':
        if (state.flow.failure) await this.finalizeFailure(ctx);
        return;
      case 'handler.failed':
        await this.onHandlerFailed(ctx, event);
        return;
      default:
        return;
    }
  }

  private async onLlmSettled(
    ctx: ConversationContext,
    event: BusEvent<'llm.settled'>,
  ): Promise<void> {
    const { state } = ctx;
    const round = currentRound(state, event.roundId);
    if (!round?.modelResult || !state.flow.llmInFlight) return;
    state.flow.llmInFlight = false;
    writePrepared(state, round);
    if (needsToolSettlement(state, round.modelResult)) {
      state.flow.toolsInFlight = true;
    }
    if (state.flow.failure) {
      await this.finalizeFailure(ctx);
      return;
    }
    await handleLlmSettled(ctx, round);
  }

  private async onToolSettled(
    ctx: ConversationContext,
    event: BusEvent<'tool.settled'>,
  ): Promise<void> {
    const { state } = ctx;
    const round = currentRound(state, event.roundId);
    if (!round?.toolSummary || !state.flow.toolsInFlight) return;
    state.flow.toolsInFlight = false;
    if (state.flow.failure) {
      await this.finalizeFailure(ctx);
      return;
    }
    const continuation = state.flow.afterTools;
    state.flow.afterTools = undefined;
    if (!continuation) return;
    await this.continueAfterTools(ctx, continuation);
  }

  private async continueAfterTools(
    ctx: ConversationContext,
    continuation: ToolContinuation,
  ): Promise<void> {
    const { state } = ctx;
    switch (continuation.kind) {
      case 'tool_results':
        await handleToolResults(ctx);
        return;
      case 'abort_streaming':
        await finishAbortStreamingAfterTools(ctx);
        return;
      case 'aborted_after_assistant':
        await finishAbortedAfterAssistant(ctx);
        return;
      case 'refusal':
        await finishRefusal(ctx);
        return;
      case 'request_error':
        for (const message of ctx.toolSummary().historyMessages) {
          ctx.emit(message);
        }
        if (continuation.isModelRefusal) {
          state.control.turnAbort.abort('Model response refused');
        }
        await finishRequestError(
          ctx,
          continuation.error,
          continuation.isModelRefusal,
        );
        return;
      case 'release_then_request':
        await ctx.request(continuation.reason, continuation.cause);
        return;
      default:
        return;
    }
  }

  private async onHandlerFailed(
    ctx: ConversationContext,
    event: BusEvent<'handler.failed'>,
  ): Promise<void> {
    const { source, roundId, error } = event.data;
    if (source !== 'llm' && source !== 'tool') return;
    const { state } = ctx;
    if (roundId !== undefined && state.round?.roundId !== roundId) return;
    if (source === 'llm') {
      state.flow.llmInFlight = false;
      // An exception before any settled result still owns the first selection.
      if (!state.model && state.round?.selection) {
        state.model = state.round.selection;
        state.task.trigger ??= state.round.taskTrigger;
        markTaskStarted(state);
      }
    } else {
      state.flow.toolsInFlight = false;
    }
    await this.finishThrown(ctx, error);
  }

  /** Conversation itself failed; finish once Llm and Tool are quiet. */
  private async finalizeFailure(ctx: ConversationContext): Promise<void> {
    const { state } = ctx;
    if (!state.flow.failure || state.flow.llmInFlight || state.flow.toolsInFlight) return;
    await this.finishThrown(ctx, state.flow.failure.error);
  }

  private async finishThrown(
    ctx: ConversationContext,
    error: unknown,
  ): Promise<void> {
    const { state } = ctx;
    const terminalError =
      error instanceof Error ? error : new Error(String(error));
    const reason: Terminal['reason'] = isCancellationError(
      error,
      state.control.abort.signal,
    )
      ? 'abort'
      : 'error';
    await ctx.finish(
      {
        reason,
        error: terminalError,
        ...(reason === 'abort'
          ? { abortKind: 'aborted_streaming' as const }
          : {}),
        ...ctx.terminalBase(state.runtime.turnCount),
      },
      { thrownError: error },
    );
  }

  private context(state: QueryState): ConversationContext {
    const { input } = state;
    const options = input.params;
    const ctx: ConversationContext = {
      state,
      hookCoordinator: options.hookCoordinator,
      emit: (event) => emitOutput(this.bus, state, event),
      request: (reason, cause) => this.request(ctx, reason, cause),
      finish: (terminal, finishOptions) =>
        this.finish(ctx, terminal, finishOptions),
      terminalBase: (numTurns) => ({
        numTurns,
        usage: state.usage,
        durationMs: Date.now() - input.startTime,
      }),
      cancelTools: (reason) => {
        const round = state.round;
        if (!round) return;
        publishFor(this.bus, state, 'tool.cancel', { reason }, round.roundId);
      },
      afterTools: (continuation) => {
        state.flow.afterTools = continuation;
      },
      checkpointTurn: (trailing: Message[] = []) => {
        const settled = state.flow.settled;
        const snapshot = settled?.result.prepared.requestSnapshot;
        if (!options.onCacheSafeSnapshot || !settled || !snapshot) return;
        options.onCacheSafeSnapshot({
          ...snapshot,
          forkContextMessages: [
            ...snapshot.forkContextMessages,
            ...normalizeMessagesForAPI(
              [...settled.assistantMessages, ...trailing],
              settled.result.prepared.projectionOptions ?? {},
            ),
          ],
          lastAssistantUsage: settled.usage,
          ...(settled.result.prepared.parentTurn &&
          !settled.interrupted &&
          !state.control.abort.signal.aborted &&
          settled.modelMessage?.stopReason === 'end_turn'
            ? { completedTurn: settled.result.prepared.parentTurn }
            : {}),
        });
      },
      fireStopFailure: (error, stopOptions, model) =>
        fireStopFailureSafely(
          options.hookCoordinator,
          error,
          stopOptions,
          state.control.abort.signal,
          model,
        ),
      toolSummary: () => state.round!.toolSummary!,
    };
    return ctx;
  }

  private async request(
    ctx: ConversationContext,
    reason: Parameters<ConversationContext['request']>[0],
    cause?: unknown,
  ): Promise<void> {
    const { state } = ctx;
    const { input } = state;
    const options = input.params;
    const { maxTurns, hookCoordinator, promptId } = options;
    // max_turns ends the turn like a normal stop: the Stop hook and its
    // TurnComplete still fire, but a continuation request is not accepted and a
    // hook failure does not change the max_turns terminal.
    if (maxTurns != null && state.runtime.turnCount >= maxTurns) {
      const lifecycle = state.lifecycle!;
      if (hookCoordinator) {
        await businessInfoContext
          .run(lifecycle.businessInfo, () =>
            hookCoordinator.fireAfter(
              promptId,
              input.promptText,
              state.cumulativeResponseText,
              {
                stopHookActive: state.runtime.stopHookActive,
                parentRequestSetId: lifecycle.requestSetId,
                parentBusinessInfo: lifecycle.businessInfo,
                customContext: options.customContext,
              },
            ),
          )
          .catch((error) => {
            runLogger.debug('[AgentLoop] max_turns stop hook failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      await ctx.finish({
        reason: 'max_turns',
        ...ctx.terminalBase(state.runtime.turnCount),
      });
      return;
    }
    const round = {
      roundId: randomUUID(),
      reason,
      requestIndex: state.requestIndex + 1,
      ...(cause !== undefined ? { cause } : {}),
    };
    state.round = round;
    state.flow.settled = undefined;
    state.flow.afterTools = undefined;
    state.flow.llmInFlight = true;
    publishFor(
      this.bus,
      state,
      'llm.request',
      { reason, requestIndex: round.requestIndex },
      round.roundId,
    );
  }

  /** Business settlement and cleanup, then query.finished. */
  private async finish(
    ctx: ConversationContext,
    terminal: Terminal,
    options: FinishOptions = {},
  ): Promise<void> {
    const { state } = ctx;
    if (state.flow.finishing) return;
    state.flow.finishing = true;
    let thrownError = options.thrownError;
    let thrown = 'thrownError' in options;
    let finalTerminal = terminal;
    try {
      finalTerminal = await this.settleTerminal(state, terminal);
    } catch (error) {
      if (!thrown) {
        thrown = true;
        thrownError = error;
      }
    }
    // Cells outlive one tool response, but never their owning query.
    try {
      await Promise.all(
        [...state.control.queryLifecycle.cleanups].map((cleanup) => cleanup()),
      );
    } catch (error) {
      runLogger.warn('[AgentLoop] Query cleanup failed:', error);
    }
    state.terminal = {
      terminal: finalTerminal,
      thrown,
      ...(thrown ? { thrownError } : {}),
    };
    publishFor(this.bus, state, 'query.finished', {
      reason: thrown ? 'thrown' : finalTerminal.reason,
    });
  }

  private async settleTerminal(
    state: QueryState,
    terminal: Terminal,
  ): Promise<Terminal> {
    const { input } = state;
    const options = input.params;
    const lifecycle = state.lifecycle;
    terminal.requestSetId ??= lifecycle?.requestSetId;
    await this.finalizeAndReportBusiness(state, terminal);
    input.queryEndState.reason ??= terminal.reason;
    input.turn.recordTerminal(terminal);
    this.reportTaskTerminal(state, terminal);
    return logTurnFinished({
      sessionId: input.sessionId,
      promptId: options.promptId,
      terminal,
    });
  }

  private async finalizeAndReportBusiness(
    state: QueryState,
    terminal: Terminal,
  ): Promise<void> {
    const lifecycle = state.lifecycle;
    if (!lifecycle || state.flow.businessFinishStarted) return;
    state.flow.businessFinishStarted = true;
    const { input } = state;
    lifecycle.finalize(terminal.reason, terminal.error);
    const reporting = Promise.all([
      // Provider-owned queue leases are released by the request scope.
      endModelRequestScope(input.sessionId, lifecycle.requestSetId),
      ...(input.params.isSubagent
        ? []
        : [
            reportBusinessFinish({
              sessionId: input.sessionId,
              businessInfo: lifecycle.businessInfo,
            }).catch((error) => {
              runLogger.warn(
                '[AgentLoop] Failed to report business finish',
                error,
              );
            }),
          ]),
    ]);
    if (input.config.isInteractive?.() === true) {
      void reporting;
      return;
    }
    await reporting;
  }

  private reportTaskTerminal(state: QueryState, terminal: Terminal): void {
    const { input, lifecycle, task } = state;
    if (!task.started || task.terminalReported || !lifecycle) return;
    task.terminalReported = true;
    const options = input.params;

    input.turn.runEnd({
      taskId: lifecycle.requestSetId,
      promptId: options.promptId,
      terminal,
      requestIndex: state.requestIndex,
      model: state.model?.key ?? input.queryEndState.model,
      statistics: input.taskRunStats.statisticsSnapshot(),
    });
  }
}
