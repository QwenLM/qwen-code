/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { tmpdir } from 'node:os';
import { HistoryReplayLimitError } from './history-replay-limit.js';
import { FileManagedSessionHistory } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-history.js';
import type {
  ChatRecord,
  GoalSnapshotV2,
  GoalStateCause,
  HistoryGap,
} from '@qwen-code/qwen-code-core';
import {
  parseGoalSnapshotV2,
  parseGoalStateCause,
  projectGoalCard,
} from '@qwen-code/qwen-code-core';
import {
  createTranscriptReplayMachine,
  MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
  type PendingTranscriptToolCall,
  type TranscriptReplayMachine,
  type TranscriptReplayPresentationAdapter,
  type TranscriptReplayStateV1,
} from '@qwen-code/acp-bridge/transcriptReplay';
import type { SessionEmitterContext } from './types.js';
import {
  buildToolResultContentPrefix,
  ToolCallEmitter,
} from './emitters/tool-call-emitter.js';
import { formatHistoryGapNotice } from '../../ui/utils/history-gap-notice.js';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';

export const MISSING_TOOL_RESULT_MESSAGE =
  MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE;

export interface PendingReplayToolCall {
  callId: string;
  toolName: string;
  resolvedToolName?: string;
  timestamp?: string;
  recordId: string;
  /**
   * The id the transcript recorded, when it differs from `callId` because a
   * collision forced a rewrite. Carried across pages so a timing frame on a
   * later page still resolves to the call the tool_call update went out with.
   */
  rawCallId?: string;
  /** Set once a timing frame has claimed this call. */
  timingMatched?: true;
}

export interface HistoryReplayPageOptions {
  pendingToolCalls?: PendingReplayToolCall[];
  finalizeDangling?: boolean;
  skipFinalizeCallIds?: ReadonlySet<string>;
  gaps?: HistoryGap[];
  goalState?: GoalSnapshotV2;
  goalCause?: GoalStateCause;
  /**
   * Emit a timing frame per `ui_telemetry` record. Paged replay opts in; the
   * bulk `replay()` path, which runs against a fixed update cap, does not.
   */
  includeTiming?: boolean;
}

export type HistoryReplayRecords =
  | readonly ChatRecord[]
  | AsyncIterable<ChatRecord>;

export interface HistoryReplayPageState {
  pendingToolCalls: PendingReplayToolCall[];
  replay: TranscriptReplayStateV1;
}

export interface HistoryReplayGoalBootstrap {
  goalStatus: {
    kind: 'set' | 'checking';
    condition: string;
    iterations?: number;
    setAt?: number;
    durationMs?: number;
    lastReason?: string;
  };
  goalState?: GoalSnapshotV2;
}

/**
 * Handles replaying session history on session load.
 *
 * Uses the unified emitters to ensure consistency with normal flow.
 * This ensures that replayed history looks identical to how it would
 * have appeared during the original session.
 */
export class HistoryReplayer {
  private readonly toolCallEmitter: ToolCallEmitter;
  private machine: TranscriptReplayMachine;

  constructor(private readonly ctx: SessionEmitterContext) {
    this.toolCallEmitter = new ToolCallEmitter(ctx);
    this.machine = this.createMachine();
  }

  async replay(
    records: HistoryReplayRecords,
    gaps?: HistoryGap[],
    options: {
      initialGoalState?: GoalSnapshotV2;
      initialGoalCause?: GoalStateCause;
      goalBootstrap?: HistoryReplayGoalBootstrap;
      skipFinalizeCallIds?: ReadonlySet<string>;
      finalizeDangling?: boolean;
    } = {},
  ): Promise<void> {
    try {
      if (options.goalBootstrap) {
        const update = {
          sessionUpdate: 'agent_message_chunk' as const,
          content: { type: 'text' as const, text: '' },
          _meta: {
            ...(options.goalBootstrap.goalState
              ? { goalState: options.goalBootstrap.goalState }
              : {}),
            goalStatus: options.goalBootstrap.goalStatus,
          },
        };
        await this.sendUpdate(update);
      }
      await this.replayPage(records, {
        finalizeDangling: options.finalizeDangling ?? true,
        gaps,
        ...(options.skipFinalizeCallIds
          ? { skipFinalizeCallIds: options.skipFinalizeCallIds }
          : {}),
        ...(options.initialGoalState
          ? { goalState: options.initialGoalState }
          : {}),
        ...(options.initialGoalCause
          ? { goalCause: options.initialGoalCause }
          : {}),
      });
    } finally {
      this.setActiveRecordId(null);
    }
  }

  static v2GoalBootstrap(
    rawGoalState: unknown,
    rawGoalCause: unknown,
  ): HistoryReplayGoalBootstrap | undefined {
    const goalState = parseGoalSnapshotV2(rawGoalState);
    const goalCause = parseGoalStateCause(rawGoalCause);
    if (!goalState?.goal || goalState.goal.status !== 'active' || !goalCause) {
      return undefined;
    }
    const { kind, ...goalStatus } = projectGoalCard({
      v: 2,
      cause: goalCause,
      snapshot: goalState,
    });
    if (kind !== 'set' && kind !== 'checking') {
      return undefined;
    }
    return { goalStatus: { ...goalStatus, kind }, goalState };
  }

  async replayPage(
    records: HistoryReplayRecords,
    options: HistoryReplayPageOptions = {},
  ): Promise<HistoryReplayPageState> {
    this.machine = this.createMachine(options);
    const scratch =
      Symbol.asyncIterator in records
        ? await FileManagedSessionHistory.create(tmpdir())
        : undefined;
    try {
      const used = scratch?.map<boolean>('resource');
      const suffixes = scratch?.map<number>('resource');
      for (const pending of options.pendingToolCalls ?? [])
        await used?.set(`used:${pending.callId}`, true);
      const claim = async (candidate: string): Promise<string> => {
        if (!used || !suffixes)
          throw new Error('Streaming replay identity view is unavailable.');
        if (!(await used.has(`used:${candidate}`))) {
          await used.set(`used:${candidate}`, true);
          return candidate;
        }
        let suffix = (await suffixes.get(`suffix:${candidate}`)) ?? 2;
        while (await used.has(`used:${candidate}:${suffix}`)) suffix++;
        const id = `${candidate}:${suffix}`;
        await used.set(`used:${id}`, true);
        await suffixes.set(`suffix:${candidate}`, suffix + 1);
        return id;
      };
      let replayError: unknown;
      try {
        for await (const record of records) {
          const emissions = scratch
            ? this.machine.projectAsync(record, claim)
            : this.machine.project(record);
          for await (const emission of emissions) {
            this.setActiveRecordId(
              emission.sourceRecordId,
              emission.sourceTimestamp,
            );
            await this.sendUpdate(emission.update);
          }
        }
      } catch (error) {
        if (error instanceof HistoryReplayLimitError) throw error;
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
        pendingToolCalls: replay.pendingToolCalls.map(toLegacyPendingToolCall),
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
    } finally {
      await scratch?.close();
    }
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
      ...(options.goalState ? { goalState: options.goalState } : {}),
      ...(options.goalCause ? { goalCause: options.goalCause } : {}),
    };
    return createTranscriptReplayMachine({
      initialState,
      gaps: options.gaps,
      presentation: this.presentationAdapter(),
      ...(options.skipFinalizeCallIds
        ? { skipFinalizeCallIds: options.skipFinalizeCallIds }
        : {}),
      ...(options.includeTiming ? { includeTiming: true } : {}),
      onDiagnostic: (diagnostic) => {
        if (
          diagnostic.code === 'malformed_part' &&
          diagnostic.path ===
            'systemPayload.outputHistoryItems.goalStatus.condition'
        ) {
          writeStderrLineSafe(`qwen: ${diagnostic.message}`);
        }
      },
    });
  }

  private presentationAdapter(): TranscriptReplayPresentationAdapter {
    return {
      resolveToolMetadata: (toolName, args) =>
        this.toolCallEmitter.resolveToolMetadata(toolName, { ...args }),
      formatHistoryGap: (gap) => formatHistoryGapNotice(gap),
      buildToolResultContentPrefix,
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
    this.ctx.setActiveRecordId?.(recordId, timestamp);
  }
}

function toPendingTranscriptToolCall(
  pending: PendingReplayToolCall,
): PendingTranscriptToolCall {
  return {
    callId: pending.callId,
    toolName: pending.toolName,
    ...(pending.resolvedToolName
      ? { resolvedToolName: pending.resolvedToolName }
      : {}),
    sourceRecordId: pending.recordId,
    ...(pending.timestamp ? { sourceTimestamp: pending.timestamp } : {}),
    ...(pending.rawCallId ? { rawCallId: pending.rawCallId } : {}),
    ...(pending.timingMatched ? { timingMatched: true as const } : {}),
  };
}

function toLegacyPendingToolCall(
  pending: PendingTranscriptToolCall,
): PendingReplayToolCall {
  return {
    callId: pending.callId,
    toolName: pending.toolName,
    ...(pending.resolvedToolName
      ? { resolvedToolName: pending.resolvedToolName }
      : {}),
    recordId: pending.sourceRecordId,
    ...(pending.sourceTimestamp ? { timestamp: pending.sourceTimestamp } : {}),
    ...(pending.rawCallId ? { rawCallId: pending.rawCallId } : {}),
    ...(pending.timingMatched ? { timingMatched: true as const } : {}),
  };
}
