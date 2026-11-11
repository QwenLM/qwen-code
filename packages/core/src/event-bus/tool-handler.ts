/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REFUSAL_REASON,
  type ToolExecutionBatch,
  type ToolExecutor,
} from '../tool-executor/tool-executor.js';
import {
  completeToolExecutions,
  type ToolExecutionSummary,
} from '../tool-executor/streaming/tool-execution-summary.js';
import { isCancellationError } from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';
import type { QueryEventBus } from './bus.js';
import type {
  AnyBusEvent,
  BusEvent,
  ToolCancelReason,
} from './events.js';
import {
  emitOutput,
  publishFor,
  yieldToEventLoop,
} from './handler-support.js';
import {
  currentRound,
  type QueryRound,
  type QueryState,
  type QueryStateStore,
  type ToolRound,
} from './state.js';

const RESPONSE_ABORT_REASONS: Record<ToolCancelReason, string> = {
  refusal: REFUSAL_REASON,
  terminal_interruption: 'Model stream interrupted',
  request_failed: 'Turn cancelled during model streaming',
};

const CANCELLED = Symbol('cancelled');

/**
 * Executes dispatched tool calls and settles each response's batch. Writes
 * only round.tools and round.toolSummary; ordering, permissions and
 * repetition stay in the executor.
 */
export class ToolHandler {
  constructor(
    private readonly bus: QueryEventBus,
    private readonly store: QueryStateStore,
  ) {}

  register(): () => void {
    return this.bus.subscribe(
      'tool',
      [
        'llm.tool_use',
        'llm.settled',
        'tool.cancel',
        'query.cancelled',
        'handler.failed',
      ],
      (event) => this.handle(event),
    );
  }

  /** This round's tool state, created on first use. */
  private toolsFor(state: QueryState, round: QueryRound): ToolRound {
    if (round.tools) return round.tools;
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const tools: ToolRound = {
      responseController: new AbortController(),
      dispatched: [],
      cancelled: false,
      cancellation,
      resolveCancellation,
      settling: false,
    };
    round.tools = tools;
    const querySignal = state.control.abort.signal;
    if (querySignal.aborted) this.cancelRound(tools, querySignal.reason);
    return tools;
  }

  private cancelRound(round: ToolRound, reason: unknown): void {
    if (!round.responseController.signal.aborted) {
      round.responseController.abort(reason);
    }
    round.cancelled = true;
    round.resolveCancellation();
  }

  // Callbacks only start work, so cancellation never waits behind a tool.
  private handle(event: AnyBusEvent): void {
    const state = this.store.get(event.queryId);
    if (!state) return;
    switch (event.type) {
      case 'query.cancelled': {
        const tools = state.round?.tools;
        if (tools) this.cancelRound(tools, state.control.abort.signal.reason);
        return;
      }
      case 'tool.cancel': {
        const tools = currentRound(state, event.roundId)?.tools;
        if (tools) this.cancelRound(tools, RESPONSE_ABORT_REASONS[event.data.reason]);
        return;
      }
      case 'llm.tool_use':
        this.execute(state, event);
        return;
      case 'llm.settled':
        this.startSettlement(state, event);
        return;
      case 'handler.failed':
        if (event.data.source === 'llm') this.releaseAfterLlmFailure(state);
        return;
      default:
        return;
    }
  }

  private executor(state: QueryState): ToolExecutor | undefined {
    return state.input.params.toolExecutor;
  }

  private execute(state: QueryState, event: BusEvent<'llm.tool_use'>): void {
    const round = currentRound(state, event.roundId);
    const toolExecutor = this.executor(state);
    const dispatch = round?.dispatch;
    if (!round || !toolExecutor || !dispatch) return;
    const tools = this.toolsFor(state, round);
    const { block, responseId, assistantMessageUuid } = event.data;
    const { input } = state;
    const options = input.params;
    const lifecycle = state.lifecycle!;
    tools.responseSignal ??= AbortSignal.any([
      dispatch.toolUseContext.signal,
      tools.responseController.signal,
    ]);
    tools.pendingToolResponseId = responseId;
    tools.dispatched.push(block);
    input.runInContext(() => {
      void toolExecutor.execute(block, {
        agentContext: input.toolAgentContext,
        agentType: options.isSubagent ? options.agentType : undefined,
        onCompletedToolCall: input.toolAgentContext.onCompletedToolCall,
        toolUseContext: dispatch.toolUseContext,
        signal: tools.responseSignal!,
        responseId,
        promptId: options.promptId,
        sessionId: input.sessionId,
        requestSetId: lifecycle.requestSetId,
        businessInfo: lifecycle.businessInfo,
        assistantMessageUuid,
        modelEntry: dispatch.modelEntry,
        repeatedCallStats: input.taskRunStats,
        repeatedCallAllowedKeys: options.repeatedToolCallAllowedKeys,
        executionDisabled: options.executionDisabled,
        imagePreparation: { config: input.config, modelKey: dispatch.modelKey },
      });
    });
  }

  private baseBatch(
    state: QueryState,
    round: QueryRound,
    tools: ToolRound,
    terminalInterruption: boolean,
  ): Omit<ToolExecutionBatch, 'signal'> {
    const options = state.input.params;
    return {
      responseId:
        tools.pendingToolResponseId ?? round.dispatch?.modelRequestId ?? '',
      sessionId: state.input.sessionId,
      promptId: options.promptId,
      terminalInterruption,
      includeSessionSnapshots: !options.isSubagent,
      settlementDeadlineMs: options.toolSettlementDeadlineMs,
    };
  }

  private startSettlement(
    state: QueryState,
    event: BusEvent<'llm.settled'>,
  ): void {
    const round = currentRound(state, event.roundId);
    const toolExecutor = this.executor(state);
    const result = round?.modelResult;
    if (!round || !toolExecutor || !result) return;
    const tools = this.toolsFor(state, round);
    // Rounds without calls get no tool.settled; Conversation does not wait.
    if (tools.dispatched.length === 0 && result.toolUseBlocks.length === 0) {
      return;
    }
    tools.settling = true;
    state.input.runInContext(() => {
      void this.settle(state, round, tools, toolExecutor, event)
        .then((summary) => {
          if (this.store.get(state.input.queryId) !== state) return;
          if (state.round !== round || round.toolSummary) return;
          round.toolSummary = summary;
          publishFor(
            this.bus,
            state,
            'tool.settled',
            {
              toolUseIds: summary.toolResults.map((r) => r.tool_use_id),
              permissionDenialCount: summary.permissionDenials.length,
              ...(summary.terminalReason
                ? { terminalReason: summary.terminalReason }
                : {}),
              hasUnknownOutcomes: summary.hasUnknownOutcomes,
              stopRequested: summary.results.some(
                (r) => r.control.stopRequested === true,
              ),
              bounded: tools.cancelled,
            },
            round.roundId,
          );
        })
        .catch((error: unknown) => {
          this.bus.reportFailure('tool', event, error);
        });
    });
  }

  private async settle(
    state: QueryState,
    round: QueryRound,
    tools: ToolRound,
    toolExecutor: ToolExecutor,
    event: BusEvent<'llm.settled'>,
  ): Promise<ToolExecutionSummary> {
    const result = round.modelResult!;
    const { assistantMessageUuid, terminalInterruption } = event.data;
    const base = this.baseBatch(state, round, tools, terminalInterruption);
    // Bounded settlement after cancellation; started calls keep their results.
    const stopBatch = (): ToolExecutionBatch => ({
      ...base,
      signal: state.control.abort.signal,
      assistantMessageUuid,
      interrupted: true,
    });

    let summary: ToolExecutionSummary;
    let completionBatch: ToolExecutionBatch;
    if (tools.cancelled || result.outcome === 'failed') {
      completionBatch = stopBatch();
      summary = await toolExecutor.stopExecution(completionBatch);
    } else {
      const waitBatch: ToolExecutionBatch = {
        ...base,
        signal: round.dispatch!.toolUseContext.signal,
        assistantMessageUuid,
        interrupted: result.outcome === 'interrupted',
      };
      completionBatch = waitBatch;
      runLogger.log(
        `[AgentLoop] Awaiting execution results for ${result.toolUseBlocks.length} tool(s)`,
      );
      try {
        summary = await this.waitOrStop(
          state,
          tools,
          toolExecutor,
          waitBatch,
          stopBatch,
        );
      } catch (toolErr) {
        runLogger.error('[AgentLoop] Tool execution failed:', toolErr);
        summary = await toolExecutor.stopExecution({
          ...waitBatch,
          failure: {
            error: toolErr,
            cancelled: isCancellationError(toolErr, waitBatch.signal),
          },
        });
      }
    }
    return completeToolExecutions(
      result.toolUseBlocks,
      summary,
      completionBatch,
    );
  }

  /** Forwards subagent events while waiting; a cancellation switches to stop. */
  private async waitOrStop(
    state: QueryState,
    tools: ToolRound,
    toolExecutor: ToolExecutor,
    waitBatch: ToolExecutionBatch,
    stopBatch: () => ToolExecutionBatch,
  ): Promise<ToolExecutionSummary> {
    const wait = toolExecutor.waitForExecutions(waitBatch);
    for (;;) {
      const next = wait.next();
      next.catch(() => undefined);
      const item = await Promise.race([
        next,
        tools.cancellation.then(() => CANCELLED),
      ]);
      if (typeof item === 'symbol') {
        // Stop first: both share the batch, and stop owns its release.
        const stopped = await toolExecutor.stopExecution(stopBatch());
        void wait.return(undefined as never).catch(() => undefined);
        return stopped;
      }
      if (item.done) return item.value;
      emitOutput(this.bus, state, item.value);
      await yieldToEventLoop();
    }
  }

  private releaseAfterLlmFailure(state: QueryState) {
    const round = state.round;
    const tools = round?.tools;
    const toolExecutor = this.executor(state);
    if (
      !round ||
      !tools ||
      !toolExecutor ||
      tools.settling ||
      tools.dispatched.length === 0
    ) {
      return;
    }
    tools.settling = true;
    this.cancelRound(tools, RESPONSE_ABORT_REASONS.request_failed);
    void toolExecutor
      .stopExecution({
        ...this.baseBatch(state, round, tools, false),
        signal: state.control.abort.signal,
        interrupted: true,
      })
      .catch((error: unknown) => {
        runLogger.debug('[AgentLoop] Failed to release tool batch:', error);
      });
  }
}
