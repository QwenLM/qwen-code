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
} from '@qwen-code/qwen-code-core';
import type {
  Content,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import type { SessionContext } from './types.js';
import { MessageEmitter } from './emitters/MessageEmitter.js';
import { ToolCallEmitter } from './emitters/ToolCallEmitter.js';

export const MISSING_TOOL_RESULT_MESSAGE =
  'Tool result missing from saved history; the previous run likely ended ' +
  'before this tool completed.';

interface PendingReplayToolCall {
  callId: string;
  toolName: string;
  timestamp?: string;
  recordId: string;
}

/**
 * Handles replaying session history on session load.
 *
 * Uses the unified emitters to ensure consistency with normal flow.
 * This ensures that replayed history looks identical to how it would
 * have appeared during the original session.
 */
export class HistoryReplayer {
  private readonly ctx: SessionContext;
  private readonly messageEmitter: MessageEmitter;
  private readonly toolCallEmitter: ToolCallEmitter;
  private readonly pendingReplayToolCalls = new Map<
    string,
    PendingReplayToolCall
  >();

  constructor(ctx: SessionContext) {
    this.ctx = ctx;
    this.messageEmitter = new MessageEmitter(ctx);
    this.toolCallEmitter = new ToolCallEmitter(ctx);
  }

  /**
   * Replays all chat records from a loaded session.
   *
   * @param records - Array of chat records to replay
   */
  async replay(records: ChatRecord[]): Promise<void> {
    this.pendingReplayToolCalls.clear();
    try {
      let replayError: unknown;
      try {
        for (const record of records) {
          await this.replayRecord(record);
        }
      } catch (error) {
        replayError = error;
      }

      let danglingError: unknown;
      try {
        await this.failDanglingToolCalls();
      } catch (error) {
        danglingError = error;
      }

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
    } finally {
      this.pendingReplayToolCalls.clear();
      this.setActiveRecordId(null);
    }
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
    const callId = this.getToolResultCallId(record);
    this.pendingReplayToolCalls.delete(callId);

    // Extract tool name from the function response in message if available
    const toolName = this.extractToolNameFromRecord(record);

    await this.toolCallEmitter.emitResult({
      toolName,
      callId,
      success: !result?.error,
      message: record.message.parts,
      resultDisplay: result?.resultDisplay,
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
   */
  private async replaySlashCommandResult(record: ChatRecord): Promise<void> {
    const payload = record.systemPayload as
      | SlashCommandRecordPayload
      | undefined;
    if (payload?.phase !== 'result' || !payload.outputHistoryItems?.length) {
      return;
    }
    for (const item of payload.outputHistoryItems) {
      const text = typeof item['text'] === 'string' ? item['text'] : '';
      if (text) {
        await this.messageEmitter.emitAgentMessage(
          text.replace(/\n/g, '  \n'),
          record.timestamp,
        );
      }
    }
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

  private getToolResultCallId(record: ChatRecord): string {
    const resultCallId = record.toolCallResult?.callId;
    if (typeof resultCallId === 'string' && resultCallId.length > 0) {
      return resultCallId;
    }
    return this.extractFunctionResponseIdFromRecord(record) ?? record.uuid;
  }

  private extractFunctionResponseIdFromRecord(
    record: ChatRecord,
  ): string | undefined {
    if (record.message?.parts) {
      for (const part of record.message.parts) {
        const id =
          'functionResponse' in part ? part.functionResponse?.id : undefined;
        if (typeof id === 'string' && id.length > 0) {
          return id;
        }
      }
    }
    return undefined;
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
