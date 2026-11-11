/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookCoordinatorAdapter } from '../../core/hook-coordinator-types.js';
import type { Message } from '../../protocol/transcript/message.js';
import type { ToolExecutionSummary } from '../../tool-executor/index.js';
import type { QueryEvent, Terminal } from '../../core/query-event.js';
import type { RequestReason, ToolCancelReason } from '../events.js';
import type { QueryState, ToolContinuation } from '../state.js';

export interface FinishOptions {
  /** query() rethrows this after QueryEnd. */
  thrownError?: unknown;
}

export interface ConversationContext {
  readonly state: QueryState;
  readonly hookCoordinator?: HookCoordinatorAdapter;
  emit(event: QueryEvent): void;
  /** Checks maxTurns, opens a round and publishes llm.request. */
  request(reason: RequestReason, cause?: unknown): Promise<void>;
  finish(terminal: Terminal, options?: FinishOptions): Promise<void>;
  terminalBase(numTurns: number): Pick<
    Terminal,
    'numTurns' | 'usage' | 'durationMs'
  >;
  cancelTools(reason: ToolCancelReason): void;
  /** Continue on tool.settled; the summary is in round.toolSummary. */
  afterTools(continuation: ToolContinuation): void;
  checkpointTurn(trailing?: Message[]): void;
  fireStopFailure(
    error: Parameters<HookCoordinatorAdapter['fireStopFailure']>[0],
    options: Parameters<HookCoordinatorAdapter['fireStopFailure']>[1],
    model?: string,
  ): Promise<void>;
  toolSummary(): ToolExecutionSummary;
}
