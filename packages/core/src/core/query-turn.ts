/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueryEvent, Terminal } from './query-event.js';
import {
  TurnHooks,
  type TurnHookModule,
  type TurnStepInput,
  type TurnStepResult,
  type TurnStepStream,
  type TurnCompleteInput,
  type TurnRunStartInput,
  type TurnRunStartResult,
  type TurnStepResultInput,
  type TurnRunEndInput,
} from './turn-hooks.js';

export interface QueryTurnOptions {
  turnId: string;
  sessionId: string;
  agentId?: string;
  isSubagent?: boolean;
  signal: AbortSignal;
  modules: readonly TurnHookModule[];
}

/** Owns one invocation's hook modules, identity and finalization. */
export class QueryTurn {
  private readonly hooks: TurnHooks;
  private readonly startedAt = Date.now();
  private active = false;
  private completed = false;
  private terminal?: Terminal;
  private answer = '';
  private answerParts: string[] = [];
  private awaitingResponse = true;
  private lastStepModel?: string;
  private stepIndex = 0;

  constructor(private readonly options: QueryTurnOptions) {
    this.hooks = new TurnHooks(options.modules, {
      sessionId: options.sessionId,
    });
  }

  async start(text: string): Promise<void> {
    if (this.active) return;
    this.active = true;
    if (!this.options.isSubagent) {
      await this.hooks.start(
        { text, turnId: this.options.turnId },
        this.options.signal,
      );
    }
  }

  observe(event: QueryEvent): void {
    if (event.type === 'request_start') {
      this.awaitingResponse = true;
      return;
    }
    if (
      event.type !== 'assistant' ||
      event.parent_tool_use_id != null ||
      event.isApiErrorMessage ||
      event.isVirtual
    )
      return;
    if (this.awaitingResponse) {
      this.answerParts = [];
      this.awaitingResponse = false;
    }
    this.answerParts.push(
      ...event.message.content.flatMap((block) =>
        block?.type === 'text' ? [block.text] : [],
      ),
    );
    this.answer = this.answerParts.join('\n').trim();
  }

  async *step(
    input: Omit<TurnStepInput, 'turnId' | 'agentId' | 'index'>,
    executeModel: (input: TurnStepInput) => TurnStepStream,
  ): TurnStepStream {
    const onStepCompleted = (result: TurnStepResult) => {
      if (result.usage) this.lastStepModel = result.usage.model;
      return result;
    };
    return yield* this.hooks.step(
      {
        ...input,
        index: this.stepIndex++,
        turnId: this.options.turnId,
        agentId: this.options.agentId,
      },
      async function* (stepInput) {
        return onStepCompleted(yield* executeModel(stepInput));
      },
      this.options.signal,
    );
  }

  runStart(
    input: Omit<TurnRunStartInput, 'turnId' | 'agentId'>,
  ): TurnRunStartResult {
    return this.hooks.runStart(
      { ...input, turnId: this.options.turnId, agentId: this.options.agentId },
      this.options.signal,
    );
  }

  stepResult(input: Omit<TurnStepResultInput, 'turnId' | 'agentId'>): void {
    this.hooks.stepResult(
      { ...input, turnId: this.options.turnId, agentId: this.options.agentId },
      this.options.signal,
    );
  }

  runEnd(input: Omit<TurnRunEndInput, 'turnId' | 'agentId'>): void {
    this.hooks.runEnd(
      { ...input, turnId: this.options.turnId, agentId: this.options.agentId },
      this.options.signal,
    );
  }

  recordTerminal(terminal: Terminal): void {
    this.terminal ??= terminal;
  }

  async complete(fallbackReason: Terminal['reason']): Promise<void> {
    if (!this.active || this.completed) return;
    this.completed = true;
    const terminal = this.terminal;
    const reason = terminal?.reason ?? fallbackReason;
    const isAborted =
      reason === 'abort' || reason === 'repeated_tool_call_denied';
    const input: TurnCompleteInput = {
      turnId: this.options.turnId,
      agentId: this.options.agentId,
      answer: this.answer,
      durationMs: terminal?.durationMs ?? Date.now() - this.startedAt,
      isAborted,
      reason: isAborted
        ? 'aborted'
        : terminal?.modelStopReason === 'refusal'
          ? 'refusal'
          : reason === 'error'
            ? 'error'
            : 'answer',
      ...(terminal?.modelStopReason === 'refusal'
        ? { refusal: { category: null, explanation: null } }
        : {}),
      ...(terminal && this.lastStepModel !== undefined
        ? {
            usage: {
              ...structuredClone(terminal.usage),
              model: this.lastStepModel,
            },
          }
        : {}),
    };
    await this.hooks.complete(input);
  }
}
