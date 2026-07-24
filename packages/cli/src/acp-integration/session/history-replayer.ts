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
import { hasFullSessionContext } from './types.js';
import { MessageEmitter } from './emitters/MessageEmitter.js';
import {
  buildToolResultContentPrefix,
  ToolCallEmitter,
} from './emitters/tool-call-emitter.js';
import { formatHistoryGapNotice } from '../../ui/utils/history-gap-notice.js';
import {
  collectGoalStatusItemsFromRecords,
  findGoalToRestore,
  goalConditionBlockedBy,
  goalRestoreBlockedBy,
  type GoalRestoreBlockedReason,
} from '../../ui/utils/restoreGoal.js';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';

/**
 * Shown on the `cleared` card that supersedes an active goal the resumed
 * session refuses to restore. `condition-invalid` never reaches here: such a
 * card is dropped from the replay outright.
 */
const GOAL_NOT_RESTORED_REASON: Record<
  Exclude<GoalRestoreBlockedReason, 'condition-invalid'>,
  string
> = {
  'untrusted-folder':
    'Goal not restored: this folder is not trusted, so its Stop hook cannot run.',
  'hooks-disabled': 'Goal not restored: hooks are disabled for this session.',
  'no-hook-system': 'Goal not restored: the hook system is unavailable.',
};

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

/**
 * Handles replaying session history on session load.
 *
 * Uses the unified emitters to ensure consistency with normal flow.
 * This ensures that replayed history looks identical to how it would
 * have appeared during the original session.
 */
export interface HistoryReplayerOptions {
  /**
   * Emit a trailing `cleared` card when the transcript ends on an active goal
   * this session will refuse to restore. Only meaningful where goal restore
   * actually follows the replay — i.e. resuming a session into a live agent.
   *
   * Off by default. A replay that merely renders a transcript (export, or
   * reading another session's history) must reproduce what happened, not
   * editorialize about a Stop hook it was never going to register. It also has
   * no business asking `config` for trust and hook policy: the export path
   * supplies a config stub that throws on any method it does not implement.
   */
  supersedeUnrestorableGoal?: boolean;
}
export class HistoryReplayer {
  private readonly messageEmitter: MessageEmitter;
  private readonly toolCallEmitter: ToolCallEmitter;
  private readonly options: HistoryReplayerOptions;
  private machine: TranscriptReplayMachine;

  constructor(
    private readonly ctx: SessionEmitterContext,
    options: HistoryReplayerOptions = {},
  ) {
    this.options = options;
    this.messageEmitter = new MessageEmitter(ctx);
    this.toolCallEmitter = new ToolCallEmitter(ctx);
    this.machine = this.createMachine();
  }

  async replay(records: ChatRecord[], gaps?: HistoryGap[]): Promise<void> {
    try {
      await this.replayPage(records, { finalizeDangling: true, gaps });
      await this.supersedeUnrestorableGoal(records);
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

  /**
   * Emits a trailing `cleared` card when the transcript ends on an active goal
   * that `restoreGoalFromHistory` is about to refuse.
   *
   * A client reads "there is an active goal" off the newest goal card it has
   * seen, so replaying a `set` card that no Stop hook will drive leaves the UI
   * claiming a goal is running when the loop is dead. The gates are pure
   * functions of `config`, so the answer is known here, before restore runs.
   *
   * This card is emitted, not recorded: the transcript keeps its `set` card, so
   * a later resume in a trusted folder (or with hooks re-enabled) restores the
   * goal instead of finding it destroyed. Emitting from inside replay is also
   * what puts the card *after* the `set` card — `loadSession` batches replay
   * updates into its response, and a notification sent afterwards would reach
   * the client first.
   *
   * Gated on `supersedeUnrestorableGoal`: only a resume registers a hook, and
   * only a resume has a `config` that answers trust and hook-policy questions.
   */
  private async supersedeUnrestorableGoal(
    records: ChatRecord[],
  ): Promise<void> {
    if (!this.options.supersedeUnrestorableGoal) return;
    const active = findGoalToRestore(
      collectGoalStatusItemsFromRecords(records),
    );
    // An invalid condition was never replayed, so no active card is on screen.
    if (!active || goalConditionBlockedBy(active.condition)) return;
    // Goal restore only follows a resume, where the context carries a config.
    if (!hasFullSessionContext(this.ctx)) return;
    const blockedBy = goalRestoreBlockedBy(this.ctx.config);
    if (!blockedBy) return;
    await this.messageEmitter.emitGoalStatus({
      kind: 'cleared',
      condition: active.condition,
      iterations: active.iterations,
      ...(active.setAt !== undefined ? { setAt: active.setAt } : {}),
      lastReason: GOAL_NOT_RESTORED_REASON[blockedBy],
    });
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
