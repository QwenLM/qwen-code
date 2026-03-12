/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config, ChatRecord } from '@qwen-code/qwen-code-core';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { SessionContext } from '../../../acp-integration/session/types.js';
import type { SessionUpdate, ToolCall } from '@agentclientprotocol/sdk';
import { HistoryReplayer } from '../../../acp-integration/session/HistoryReplayer.js';
import type {
  ExportMessage,
  ExportSessionData,
  ExportMetadata,
} from './types.js';

/**
 * File operation statistics extracted from tool calls.
 */
interface FileOperationStats {
  filesRead: number;
  filesWritten: number;
  linesAdded: number;
  linesRemoved: number;
  uniqueFiles: Set<string>;
}

/**
 * Calculate file operation statistics from ChatRecords.
 * Uses toolCallResult from tool_result records for accurate statistics.
 */
function calculateFileStats(records: ChatRecord[]): FileOperationStats {
  const stats: FileOperationStats = {
    filesRead: 0,
    filesWritten: 0,
    linesAdded: 0,
    linesRemoved: 0,
    uniqueFiles: new Set(),
  };

  for (const record of records) {
    if (record.type !== 'tool_result' || !record.toolCallResult) continue;

    const { resultDisplay } = record.toolCallResult;

    // Track file locations from resultDisplay
    if (
      resultDisplay &&
      typeof resultDisplay === 'object' &&
      'fileName' in resultDisplay
    ) {
      const display = resultDisplay as {
        fileName: string;
        originalContent?: string | null;
        newContent?: string;
        diffStat?: { model_added_lines?: number; model_removed_lines?: number };
      };

      // Track unique files
      if (typeof display.fileName === 'string') {
        stats.uniqueFiles.add(display.fileName);
      }

      // Determine operation type based on content fields
      const hasOriginalContent = 'originalContent' in display;
      const hasNewContent = 'newContent' in display;

      if (hasOriginalContent || hasNewContent) {
        // This is a write/edit operation
        stats.filesWritten++;

        // Calculate line changes
        if (display.diffStat) {
          // Use diffStat if available for accurate counts
          stats.linesAdded += display.diffStat.model_added_lines ?? 0;
          stats.linesRemoved += display.diffStat.model_removed_lines ?? 0;
        } else {
          // Fallback: count lines in content
          const oldText = String(display.originalContent ?? '');
          const newText = String(display.newContent ?? '');

          // Count non-empty lines
          const oldLines = oldText
            .split('\n')
            .filter((line) => line.length > 0).length;
          const newLines = newText
            .split('\n')
            .filter((line) => line.length > 0).length;

          stats.linesAdded += newLines;
          stats.linesRemoved += oldLines;
        }
      } else {
        // This is likely a read operation (no content changes)
        stats.filesRead++;
      }
    }
  }

  return stats;
}

/**
 * Calculate token statistics from ChatRecords.
 * Aggregates usageMetadata from assistant records to get total token usage.
 */
function calculateTokenStats(
  records: ChatRecord[],
  contextWindowSize?: number,
): { totalTokens: number; promptTokens: number; contextUsagePercent?: number } {
  let totalTokens = 0;
  let lastPromptTokens = 0;

  // Aggregate usageMetadata from all assistant records
  // Use last available promptTokenCount for context usage calculation
  for (const record of records) {
    if (record.type === 'assistant' && record.usageMetadata) {
      totalTokens += record.usageMetadata.totalTokenCount ?? 0;
      // Use the last available promptTokenCount (represents current context usage)
      if (record.usageMetadata.promptTokenCount !== undefined) {
        lastPromptTokens = record.usageMetadata.promptTokenCount;
      }
    }
  }

  // Use promptTokens (input tokens) for context usage calculation
  // This represents how much of the context window is being used
  if (contextWindowSize && lastPromptTokens > 0) {
    const percent = (lastPromptTokens / contextWindowSize) * 100;
    return {
      totalTokens,
      promptTokens: lastPromptTokens,
      contextUsagePercent: Math.round(percent * 10) / 10,
    };
  }

  return { totalTokens, promptTokens: lastPromptTokens };
}

/**
 * Extract session metadata from ChatRecords.
 */
function extractMetadata(
  conversation: {
    sessionId: string;
    startTime: string;
    messages: ChatRecord[];
  },
  config: Config,
): ExportMetadata {
  const { sessionId, startTime, messages } = conversation;

  // Extract basic info from the first record
  const firstRecord = messages[0];
  const cwd = firstRecord?.cwd ?? '';
  const gitBranch = firstRecord?.gitBranch;

  // Try to get model from assistant messages
  let model: string | undefined;
  for (const record of messages) {
    if (record.type === 'assistant' && record.model) {
      model = record.model;
      break;
    }
  }

  // Get channel from config
  const channel = config.getChannel?.();

  // Count user prompts
  const promptCount = messages.filter((m) => m.type === 'user').length;

  // Get context window size
  const contentGenConfig = config.getContentGeneratorConfig?.();
  const contextWindowSize = contentGenConfig?.contextWindowSize;

  // Calculate file stats from original ChatRecords
  const fileStats = calculateFileStats(messages);

  // Calculate token stats from original ChatRecords
  const tokenStats = calculateTokenStats(messages, contextWindowSize);

  // Extract the last response_id from assistant records (for request tracking)
  let requestId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const record = messages[i];
    if (record.type === 'assistant' && record.response_id) {
      requestId = record.response_id;
      break;
    }
  }

  return {
    sessionId,
    startTime,
    exportTime: new Date().toISOString(),
    cwd,
    gitBranch,
    model,
    channel,
    promptCount,
    contextUsagePercent: tokenStats.contextUsagePercent,
    totalTokens: tokenStats.totalTokens,
    filesRead: fileStats.filesRead,
    filesWritten: fileStats.filesWritten,
    linesAdded: fileStats.linesAdded,
    linesRemoved: fileStats.linesRemoved,
    uniqueFiles: Array.from(fileStats.uniqueFiles),
    requestId,
  };
}

/**
 * Export session context that captures session updates into export messages.
 * Implements SessionContext to work with HistoryReplayer.
 */
class ExportSessionContext implements SessionContext {
  readonly sessionId: string;
  readonly config: Config;
  private messages: ExportMessage[] = [];
  private currentMessage: {
    type: 'user' | 'assistant';
    role: 'user' | 'assistant' | 'thinking';
    parts: Array<{ text: string }>;
    timestamp: number;
    usageMetadata?: GenerateContentResponseUsageMetadata;
  } | null = null;
  private activeRecordId: string | null = null;
  private activeRecordTimestamp: string | null = null;
  private toolCallMap: Map<string, ExportMessage['toolCall']> = new Map();

  constructor(sessionId: string, config: Config) {
    this.sessionId = sessionId;
    this.config = config;
  }

  async sendUpdate(update: SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        this.handleMessageChunk('user', update.content);
        break;
      case 'agent_message_chunk': {
        // Extract usageMetadata from _meta if available
        const usageMeta = update._meta as
          | {
              usage?: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                thoughtTokens?: number;
                cachedReadTokens?: number;
              };
            }
          | undefined;
        const usageMetadata: GenerateContentResponseUsageMetadata | undefined =
          usageMeta?.usage
            ? {
                promptTokenCount: usageMeta.usage.inputTokens,
                candidatesTokenCount: usageMeta.usage.outputTokens,
                totalTokenCount: usageMeta.usage.totalTokens,
                thoughtsTokenCount: usageMeta.usage.thoughtTokens,
                cachedContentTokenCount: usageMeta.usage.cachedReadTokens,
              }
            : undefined;
        this.handleMessageChunk(
          'assistant',
          update.content,
          'assistant',
          usageMetadata,
        );
        break;
      }
      case 'agent_thought_chunk':
        this.handleMessageChunk('assistant', update.content, 'thinking');
        break;
      case 'tool_call':
        this.flushCurrentMessage();
        this.handleToolCallStart(update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(update);
        break;
      case 'plan':
        this.flushCurrentMessage();
        this.handlePlanUpdate(update);
        break;
      default:
        // Ignore other update types
        break;
    }
  }

  setActiveRecordId(recordId: string | null, timestamp?: string): void {
    this.activeRecordId = recordId;
    this.activeRecordTimestamp = timestamp ?? null;
  }

  private getMessageTimestamp(): string {
    return this.activeRecordTimestamp ?? new Date().toISOString();
  }

  private getMessageUuid(): string {
    return this.activeRecordId ?? randomUUID();
  }

  private handleMessageChunk(
    role: 'user' | 'assistant',
    content: { type: string; text?: string },
    messageRole: 'user' | 'assistant' | 'thinking' = role,
    usageMetadata?: GenerateContentResponseUsageMetadata,
  ): void {
    if (content.type !== 'text' || !content.text) return;

    // If we're starting a new message type, flush the previous one
    if (
      this.currentMessage &&
      (this.currentMessage.type !== role ||
        this.currentMessage.role !== messageRole)
    ) {
      this.flushCurrentMessage();
    }

    // Add to current message or create new one
    if (
      this.currentMessage &&
      this.currentMessage.type === role &&
      this.currentMessage.role === messageRole
    ) {
      this.currentMessage.parts.push({ text: content.text });
      // Merge usageMetadata if provided (for assistant messages)
      if (usageMetadata && role === 'assistant') {
        this.currentMessage.usageMetadata = usageMetadata;
      }
    } else {
      this.currentMessage = {
        type: role,
        role: messageRole,
        parts: [{ text: content.text }],
        timestamp: Date.now(),
        ...(usageMetadata && role === 'assistant' ? { usageMetadata } : {}),
      };
    }
  }

  private handleToolCallStart(update: ToolCall): void {
    const toolCall: ExportMessage['toolCall'] = {
      toolCallId: update.toolCallId,
      kind: update.kind || 'other',
      title:
        typeof update.title === 'string' ? update.title : update.title || '',
      status: update.status || 'pending',
      rawInput: update.rawInput as string | object | undefined,
      locations: update.locations,
      timestamp: Date.now(),
    };

    this.toolCallMap.set(update.toolCallId, toolCall);

    // Immediately add tool call to messages to preserve order
    const uuid = this.getMessageUuid();
    this.messages.push({
      uuid,
      sessionId: this.sessionId,
      timestamp: this.getMessageTimestamp(),
      type: 'tool_call',
      toolCall,
    });
  }

  private handleToolCallUpdate(update: {
    toolCallId: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null;
    title?: string | null;
    content?: Array<{ type: string; [key: string]: unknown }> | null;
    kind?: string | null;
  }): void {
    const toolCall = this.toolCallMap.get(update.toolCallId);
    if (toolCall) {
      // Update the tool call in place
      if (update.status) toolCall.status = update.status;
      if (update.content) toolCall.content = update.content;
      if (update.title)
        toolCall.title = typeof update.title === 'string' ? update.title : '';
    }
  }

  private handlePlanUpdate(update: {
    entries: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      priority?: string;
    }>;
  }): void {
    // Create a tool_call message for plan updates (TodoWriteTool)
    // This ensures todos appear at the correct position in the chat
    const uuid = this.getMessageUuid();
    const timestamp = this.getMessageTimestamp();

    // Format entries as markdown checklist text for UpdatedPlanToolCall.parsePlanEntries
    const todoText = update.entries
      .map((entry) => {
        const checkbox =
          entry.status === 'completed'
            ? '[x]'
            : entry.status === 'in_progress'
              ? '[-]'
              : '[ ]';
        return `- ${checkbox} ${entry.content}`;
      })
      .join('\n');

    const todoContent = [
      {
        type: 'content' as const,
        content: {
          type: 'text',
          text: todoText,
        },
      },
    ];

    this.messages.push({
      uuid,
      sessionId: this.sessionId,
      timestamp,
      type: 'tool_call',
      toolCall: {
        toolCallId: uuid, // Use the same uuid as toolCallId for plan updates
        kind: 'todowrite',
        title: 'TodoWrite',
        status: 'completed',
        content: todoContent,
        timestamp: Date.parse(timestamp),
      },
    });
  }

  private flushCurrentMessage(): void {
    if (!this.currentMessage) return;

    const uuid = this.getMessageUuid();
    const exportMessage: ExportMessage = {
      uuid,
      sessionId: this.sessionId,
      timestamp: this.getMessageTimestamp(),
      type: this.currentMessage.type,
      message: {
        role: this.currentMessage.role,
        parts: this.currentMessage.parts,
      },
    };

    // Add usageMetadata for assistant messages
    if (
      this.currentMessage.type === 'assistant' &&
      this.currentMessage.usageMetadata
    ) {
      exportMessage.usageMetadata = this.currentMessage.usageMetadata;
    }

    this.messages.push(exportMessage);

    this.currentMessage = null;
  }

  flushMessages(): void {
    this.flushCurrentMessage();
  }

  getMessages(): ExportMessage[] {
    return this.messages;
  }
}

/**
 * Collects session data from ChatRecord[] using HistoryReplayer.
 * Returns the raw ExportSessionData (SSOT) without normalization.
 */
export async function collectSessionData(
  conversation: {
    sessionId: string;
    startTime: string;
    messages: ChatRecord[];
  },
  config: Config,
): Promise<ExportSessionData> {
  // Create export session context
  const exportContext = new ExportSessionContext(
    conversation.sessionId,
    config,
  );

  // Create history replayer with export context
  const replayer = new HistoryReplayer(exportContext);

  // Replay chat records to build export messages
  await replayer.replay(conversation.messages);

  // Flush any buffered messages
  exportContext.flushMessages();

  // Get the export messages
  const messages = exportContext.getMessages();

  // Extract metadata from conversation
  const metadata = extractMetadata(conversation, config);

  return {
    sessionId: conversation.sessionId,
    startTime: conversation.startTime,
    messages,
    metadata,
  };
}
