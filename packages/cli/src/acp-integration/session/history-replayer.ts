/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord, HistoryGap } from '@qwen-code/qwen-code-core';
import {
  createTranscriptReplayMachine,
  MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
  type PendingTranscriptToolCall,
  type TranscriptReplayMachine,
  type TranscriptReplayPresentationAdapter,
  type TranscriptReplayStateV1,
} from '@qwen-code/acp-bridge/transcriptReplay';
import type { SessionEmitterContext } from './types.js';
import { ToolCallEmitter } from './emitters/tool-call-emitter.js';
import { formatHistoryGapNotice } from '../../ui/utils/history-gap-notice.js';

export const MISSING_TOOL_RESULT_MESSAGE =
  MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE;

export interface PendingReplayToolCall {
  callId: string;
  toolName: string;
  timestamp?: string;
  recordId: string;
}

export interface HistoryReplayPageOptions {
  pendingToolCalls?: PendingReplayToolCall[];
  finalizeDangling?: boolean;
  gaps?: HistoryGap[];
}

export interface HistoryReplayPageState {
  pendingToolCalls: PendingReplayToolCall[];
  replay: TranscriptReplayStateV1;
}

export class HistoryReplayer {
  private readonly toolCallEmitter: ToolCallEmitter;
  private machine: TranscriptReplayMachine;

  constructor(private readonly ctx: SessionEmitterContext) {
    this.toolCallEmitter = new ToolCallEmitter(ctx);
    this.machine = this.createMachine();
  }

  async replay(records: ChatRecord[], gaps?: HistoryGap[]): Promise<void> {
    try {
      await this.replayPage(records, { finalizeDangling: true, gaps });
    } finally {
      this.setActiveRecordId(null);
    }
  }

  async replayPage(
    records: ChatRecord[],
    options: HistoryReplayPageOptions = {},
  ): Promise<HistoryReplayPageState> {
    this.machine = this.createMachine(options);
    let replayError: unknown;
    try {
      for (const record of records) {
        for (const emission of this.machine.project(record)) {
          this.setActiveRecordId(
            emission.sourceRecordId,
            emission.sourceTimestamp,
          );
          await this.sendUpdate(emission.update);
        }
      }
    } catch (error) {
      replayError = error;
    }

    let danglingError: unknown;
    if (options.finalizeDangling === true) {
      for (const emission of this.machine.finalize()) {
        this.setActiveRecordId(
          emission.sourceRecordId,
          emission.sourceTimestamp,
        );
        try {
          await this.sendUpdate(emission.update);
        } catch (error) {
          danglingError ??= error;
        }
      }
    }

    const replay = this.machine.snapshot();
    this.copyCumulativeUsage(replay);
    const state = {
      pendingToolCalls:
        options.finalizeDangling === true
          ? []
          : replay.pendingToolCalls.map(toLegacyPendingToolCall),
      replay,
    };
    this.setActiveRecordId(null);

    if (replayError && danglingError) {
      throw new AggregateError(
        [replayError, danglingError],
        'Replay and dangling-cleanup both failed',
      );
    }
    if (replayError) throw replayError;
    if (danglingError) throw danglingError;
    return state;
  }

  getPendingToolCalls(): PendingReplayToolCall[] {
    return this.machine
      .snapshot()
      .pendingToolCalls.map(toLegacyPendingToolCall);
  }

  getReplayState(): TranscriptReplayStateV1 {
    return this.machine.snapshot();
  }

  private createMachine(
    options: HistoryReplayPageOptions = {},
  ): TranscriptReplayMachine {
    const cumulative = this.ctx.cumulativeUsage;
    const initialState: TranscriptReplayStateV1 = {
      v: 1,
      pendingToolCalls: (options.pendingToolCalls ?? []).map(
        toPendingTranscriptToolCall,
      ),
      cumulativeUsage: cumulative
        ? { ...cumulative }
        : {
            promptTokens: 0,
            cachedTokens: 0,
            candidateTokens: 0,
            apiTimeMs: 0,
          },
    };
    return createTranscriptReplayMachine({
      initialState,
      gaps: options.gaps,
      presentation: this.presentationAdapter(),
    });
  }

  private presentationAdapter(): TranscriptReplayPresentationAdapter {
    return {
      resolveToolMetadata: (toolName, args) =>
        this.toolCallEmitter.resolveToolMetadata(toolName, { ...args }),
      formatHistoryGap: (gap) => formatHistoryGapNotice(gap),
    };
  }

  private async sendUpdate(
    update: Parameters<SessionEmitterContext['sendUpdate']>[0],
  ): Promise<void> {
    if (this.ctx.messageRewriter) {
      await this.ctx.messageRewriter.interceptUpdate(update);
      return;
    }
    await this.ctx.sendUpdate(update);
  }

  private copyCumulativeUsage(state: TranscriptReplayStateV1): void {
    const cumulative = this.ctx.cumulativeUsage;
    if (!cumulative) return;
    cumulative.promptTokens = state.cumulativeUsage.promptTokens;
    cumulative.cachedTokens = state.cumulativeUsage.cachedTokens;
    cumulative.candidateTokens = state.cumulativeUsage.candidateTokens;
    cumulative.apiTimeMs = state.cumulativeUsage.apiTimeMs;
  }

  private setActiveRecordId(recordId: string | null, timestamp?: string): void {
    const context = this.ctx as unknown as {
      setActiveRecordId?: (id: string | null, timestamp?: string) => void;
    };
    context.setActiveRecordId?.(recordId, timestamp);
  }
}

function toPendingTranscriptToolCall(
  pending: PendingReplayToolCall,
): PendingTranscriptToolCall {
  return {
    callId: pending.callId,
    toolName: pending.toolName,
    sourceRecordId: pending.recordId,
    ...(pending.timestamp ? { sourceTimestamp: pending.timestamp } : {}),
  };
}

function toLegacyPendingToolCall(
  pending: PendingTranscriptToolCall,
): PendingReplayToolCall {
  return {
    callId: pending.callId,
    toolName: pending.toolName,
    recordId: pending.sourceRecordId,
    ...(pending.sourceTimestamp ? { timestamp: pending.sourceTimestamp } : {}),
  };
}
