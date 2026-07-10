/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  AgentResultDisplay,
  SlashCommandRecordPayload,
  NotificationRecordPayload,
  HistoryGap,
} from '@qwen-code/qwen-code-core';
import type {
  Content,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import type { SessionContext } from './types.js';
import { MessageEmitter } from './emitters/MessageEmitter.js';
import { ToolCallEmitter } from './emitters/ToolCallEmitter.js';
import { getToolResultCallId } from '../../utils/chat-record-tool-call-id.js';
import {
  formatHistoryGapNotice,
  indexGapsByChild,
} from '../../ui/utils/history-gap-notice.js';
import {
  collectGoalStatusItemsFromRecords,
  findGoalToRestore,
  goalConditionBlockedBy,
  goalRestoreBlockedBy,
  isTranscriptItemRecord,
  parseGoalStatusItem,
  type GoalRestoreBlockedReason,
} from '../../ui/utils/restoreGoal.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

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
  'Tool result missing from saved history; the previous run likely ended ' +
  'before this tool completed.';

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
  private readonly ctx: SessionContext;
  private readonly messageEmitter: MessageEmitter;
  private readonly toolCallEmitter: ToolCallEmitter;
  private readonly options: HistoryReplayerOptions;
  private readonly pendingReplayToolCalls = new Map<
    string,
    PendingReplayToolCall
  >();

  constructor(ctx: SessionContext, options: HistoryReplayerOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    this.messageEmitter = new MessageEmitter(ctx);
    this.toolCallEmitter = new ToolCallEmitter(ctx);
  }

  /**
   * Replays all chat records from a loaded session.
   *
   * @param records - Array of chat records to replay
   * @param gaps - Optional detected history gaps; a visible notice is emitted
   *   immediately before each gap's child record so the user sees that an
   *   earlier segment was lost rather than assuming the halves are contiguous.
   */
  async replay(records: ChatRecord[], gaps?: HistoryGap[]): Promise<void> {
    try {
      await this.replayPage(records, { finalizeDangling: true, gaps });
      await this.supersedeUnrestorableGoal(records);
    } finally {
      this.pendingReplayToolCalls.clear();
      this.setActiveRecordId(null);
    }
  }

  async replayPage(
    records: ChatRecord[],
    options: HistoryReplayPageOptions = {},
  ): Promise<HistoryReplayPageState> {
    this.pendingReplayToolCalls.clear();
    for (const pending of options.pendingToolCalls ?? []) {
      this.pendingReplayToolCalls.set(pending.callId, pending);
    }

    const gapByChildUuid = indexGapsByChild(options.gaps);
    let replayError: unknown;
    try {
      for (const record of records) {
        const gap = gapByChildUuid.get(record.uuid);
        if (gap) {
          await this.emitHistoryGapNotice(gap, record.timestamp);
        }
        await this.replayRecord(record);
      }
    } catch (error) {
      replayError = error;
    }

    let danglingError: unknown;
    if (options.finalizeDangling === true) {
      try {
        await this.failDanglingToolCalls();
      } catch (error) {
        danglingError = error;
      }
    }

    const state = {
      pendingToolCalls:
        options.finalizeDangling === true
          ? []
          : Array.from(this.pendingReplayToolCalls.values()),
    };
    this.setActiveRecordId(null);

    if (replayError && danglingError) {
      throw new AggregateError(
        [replayError, danglingError],
        'Replay and dangling-cleanup both failed',
      );
    }
    if (replayError) {
      throw replayError;
    }
    if (danglingError) {
      throw danglingError;
    }
    return state;
  }

  getPendingToolCalls(): PendingReplayToolCall[] {
    return Array.from(this.pendingReplayToolCalls.values());
  }

  /**
   * Replays a single chat record.
   */
  private async replayRecord(record: ChatRecord): Promise<void> {
    this.setActiveRecordId(record.uuid, record.timestamp);
    try {
      switch (record.type) {
        case 'user':
          // Notification/cron records hold raw XML/prompt the user never
          // typed; replay the friendly displayText so the assistant's reply
          // has an antecedent in the ACP transcript.
          if (record.subtype === 'notification' || record.subtype === 'cron') {
            const displayText = (
              record.systemPayload as NotificationRecordPayload | undefined
            )?.displayText;
            if (displayText) {
              await this.messageEmitter.emitUserMessage(
                displayText,
                record.timestamp,
                record.subtype === 'cron' ? { source: 'cron' } : undefined,
              );
            }
            break;
          }
          if (record.subtype === 'mid_turn_user_message') {
            const displayText = (
              record.systemPayload as NotificationRecordPayload | undefined
            )?.displayText;
            if (displayText) {
              await this.messageEmitter.emitUserMessage(
                displayText,
                record.timestamp,
              );
            } else if (record.message) {
              await this.replayContent(
                record.message,
                'user',
                record.timestamp,
                record.uuid,
              );
            }
            break;
          }
          if (record.message) {
            await this.replayContent(
              record.message,
              'user',
              record.timestamp,
              record.uuid,
            );
          }
          break;

        case 'assistant':
          if (record.message) {
            await this.replayContent(
              record.message,
              'assistant',
              record.timestamp,
              record.uuid,
            );
          }
          if (record.usageMetadata) {
            await this.replayUsageMetadata(record.usageMetadata);
          }
          break;

        case 'tool_result':
          await this.replayToolResult(record);
          break;

        case 'system':
          if (record.subtype === 'slash_command') {
            await this.replaySlashCommandResult(record);
          }
          // Other system subtypes (compression, telemetry, at_command) are skipped.
          break;

        default:
          break;
      }
    } finally {
      this.setActiveRecordId(null);
    }
  }

  /**
   * Emits a visible notice marking a break in the persisted history chain: an
   * earlier segment was physically lost (storage interruption) and could not be
   * recovered, so the surviving turns below must not be read as contiguous with
   * whatever came before the gap. Uses the agent message channel — the same one
   * used for other system notices (see MessageEmitter.emitStopHookLoop) — so no
   * new session-update kind is needed.
   */
  private async emitHistoryGapNotice(
    gap: HistoryGap,
    timestamp?: string,
  ): Promise<void> {
    await this.messageEmitter.emitAgentMessage(
      formatHistoryGapNotice(gap),
      timestamp,
    );
  }

  /**
   * Replays content from a message (user or assistant).
   * Handles text parts, thought parts, and function calls.
   *
   * @param content - The content to replay
   * @param role - The role (user or assistant)
   * @param timestamp - Optional server-side timestamp from the JSONL record
   */
  private async replayContent(
    content: Content,
    role: 'user' | 'assistant',
    timestamp?: string,
    recordId?: string,
  ): Promise<void> {
    for (const part of content.parts ?? []) {
      // Text content
      if ('text' in part && part.text) {
        const isThought = (part as { thought?: boolean }).thought ?? false;
        await this.messageEmitter.emitMessage(
          part.text,
          role,
          isThought,
          timestamp,
        );
      }

      // Function call (tool start)
      if ('functionCall' in part && part.functionCall) {
        const functionName = part.functionCall.name ?? '';
        const sourceCallId = part.functionCall.id;
        const callId = sourceCallId ?? `${functionName}-${Date.now()}`;

        const emitted = await this.toolCallEmitter.emitStart({
          toolName: functionName,
          callId,
          args: part.functionCall.args as Record<string, unknown>,
          status: 'in_progress',
          timestamp,
        });

        if (emitted && role === 'assistant' && recordId && sourceCallId) {
          this.pendingReplayToolCalls.set(callId, {
            callId,
            toolName: functionName,
            timestamp,
            recordId,
          });
        }
      }
    }
  }

  /**
   * Replays usage metadata.
   * @param usageMetadata - The usage metadata to replay
   */
  private async replayUsageMetadata(
    usageMetadata: GenerateContentResponseUsageMetadata,
  ): Promise<void> {
    await this.messageEmitter.emitUsageMetadata(usageMetadata);
  }

  /**
   * Replays a tool result record.
   */
  private async replayToolResult(record: ChatRecord): Promise<void> {
    // message is required - skip if not present
    if (!record.message?.parts) {
      return;
    }

    const result = record.toolCallResult;
    const callId = getToolResultCallId(record);
    this.pendingReplayToolCalls.delete(callId);

    // Extract tool name from the function response in message if available
    const toolName = this.extractToolNameFromRecord(record);

    await this.toolCallEmitter.emitResult({
      toolName,
      callId,
      success: !result?.error,
      message: record.message.parts,
      resultDisplay: result?.resultDisplay,
      artifacts: result?.artifacts,
      // For TodoWriteTool fallback, try to extract args from the record
      // Note: args aren't stored in tool_result records by default
      args: undefined,
      timestamp: record.timestamp,
    });

    // Special handling: Task tool execution summary contains token usage
    const { resultDisplay } = result ?? {};
    if (
      !!resultDisplay &&
      typeof resultDisplay === 'object' &&
      'type' in resultDisplay &&
      (resultDisplay as { type?: unknown }).type === 'task_execution'
    ) {
      await this.emitTaskUsageFromResultDisplay(
        resultDisplay as AgentResultDisplay,
      );
    }
  }

  private async failDanglingToolCalls(): Promise<void> {
    let firstError: unknown;
    for (const pending of this.pendingReplayToolCalls.values()) {
      this.setActiveRecordId(pending.recordId, pending.timestamp);
      try {
        await this.toolCallEmitter.emitResult({
          toolName: pending.toolName,
          callId: pending.callId,
          success: false,
          message: [],
          error: new Error(MISSING_TOOL_RESULT_MESSAGE),
          timestamp: pending.timestamp,
        });
      } catch (error) {
        firstError ??= error;
      } finally {
        this.setActiveRecordId(null);
      }
    }
    if (firstError) {
      throw firstError;
    }
  }

  /**
   * Emits token usage from a AgentResultDisplay execution summary, if present.
   */
  private async emitTaskUsageFromResultDisplay(
    resultDisplay: AgentResultDisplay,
  ): Promise<void> {
    const summary = resultDisplay.executionSummary;
    if (!summary) {
      return;
    }

    const usageMetadata: GenerateContentResponseUsageMetadata = {};

    if (Number.isFinite(summary.inputTokens)) {
      usageMetadata.promptTokenCount = summary.inputTokens;
    }
    if (Number.isFinite(summary.outputTokens)) {
      usageMetadata.candidatesTokenCount = summary.outputTokens;
    }
    if (Number.isFinite(summary.thoughtTokens)) {
      usageMetadata.thoughtsTokenCount = summary.thoughtTokens;
    }
    if (Number.isFinite(summary.cachedTokens)) {
      usageMetadata.cachedContentTokenCount = summary.cachedTokens;
    }
    if (Number.isFinite(summary.totalTokens)) {
      usageMetadata.totalTokenCount = summary.totalTokens;
    }

    // Only emit if we captured at least one token metric
    if (Object.keys(usageMetadata).length > 0) {
      await this.messageEmitter.emitUsageMetadata(usageMetadata);
    }
  }

  /**
   * Replays a slash_command system record by re-emitting its output as an
   * agent message chunk. This allows Zed to reconstruct the correct turn
   * structure (user → agent) on session resume without polluting model context.
   *
   * Goal cards are re-emitted as `_meta.goalStatus` rather than text: they carry
   * no `text` field, so the plain-text path below would silently drop them and
   * the client would lose the goal card (and its status pill) on every reload.
   * Per-iteration `checking` cards are skipped — a TUI transcript persists one
   * per stop-hook turn, and clients suppress them as noise. Skipping costs no
   * fidelity: goal restore reads the records directly, not this replay.
   */
  private async replaySlashCommandResult(record: ChatRecord): Promise<void> {
    const payload = record.systemPayload as
      | SlashCommandRecordPayload
      | undefined;
    if (payload?.phase !== 'result') return;
    // Typed as an array, but it came off disk: a hand-edited record could make
    // it any JSON value, and iterating a plain object throws.
    const items: unknown = payload.outputHistoryItems;
    if (!Array.isArray(items) || items.length === 0) return;
    for (const item of items) {
      const goalStatus = parseGoalStatusItem(item);
      if (goalStatus) {
        if (goalConditionBlockedBy(goalStatus.condition)) {
          // A transcript is a file: a corrupted or hand-edited condition would
          // otherwise ride out to every client inside `_meta.goalStatus`.
          // `restoreGoalFromHistory` refuses the same card, so skipping it here
          // keeps the card and the hook consistent — neither survives.
          writeStderrLine(
            'qwen: skipping replay of a goal card whose condition is empty.',
          );
        } else if (goalStatus.kind !== 'checking') {
          const { type: _type, ...status } = goalStatus;
          await this.messageEmitter.emitGoalStatus(status);
        }
        continue;
      }
      // Not a goal card, and not necessarily an object either.
      const text =
        isTranscriptItemRecord(item) && typeof item['text'] === 'string'
          ? item['text']
          : '';
      if (text) {
        await this.messageEmitter.emitAgentMessage(
          text.replace(/\n/g, '  \n'),
          record.timestamp,
        );
      }
    }
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

  /**
   * Extracts tool name from a chat record's function response.
   */
  private extractToolNameFromRecord(record: ChatRecord): string {
    // Try to get from functionResponse in message
    if (record.message?.parts) {
      for (const part of record.message.parts) {
        if ('functionResponse' in part && part.functionResponse?.name) {
          return part.functionResponse.name;
        }
      }
    }
    return '';
  }

  private setActiveRecordId(recordId: string | null, timestamp?: string): void {
    const context = this.ctx as unknown as {
      setActiveRecordId?: (id: string | null, timestamp?: string) => void;
    };
    if (typeof context.setActiveRecordId === 'function') {
      context.setActiveRecordId(recordId, timestamp);
    }
  }
}
