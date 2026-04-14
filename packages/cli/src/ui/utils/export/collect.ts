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
  filesWritten: number;
  linesAdded: number;
  linesRemoved: number;
  writtenFilePaths: Set<string>;
}

/**
 * Tool call arguments index for matching tool_result records.
 */
interface ToolCallArgsIndex {
  byId: Map<string, Record<string, unknown>>;
  byName: Map<string, Array<Record<string, unknown>>>;
}

/**
 * Extracts tool name from a ChatRecord's function response.
 */
function extractToolNameFromRecord(record: ChatRecord): string | undefined {
  if (!record.message?.parts) {
    return undefined;
  }

  for (const part of record.message.parts) {
    if ('functionResponse' in part && part.functionResponse?.name) {
      return part.functionResponse.name;
    }
  }

  return undefined;
}

/**
 * Extracts call ID from a ChatRecord's function response.
 */
function extractFunctionResponseId(record: ChatRecord): string | undefined {
  if (!record.message?.parts) {
    return undefined;
  }

  for (const part of record.message.parts) {
    if ('functionResponse' in part && part.functionResponse?.id) {
      return part.functionResponse.id;
    }
  }

  return undefined;
}

/**
 * Normalizes function call args into a plain object.
 */
function normalizeFunctionCallArgs(
  args: unknown,
): Record<string, unknown> | undefined {
  if (args && typeof args === 'object') {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors and treat as unavailable args
    }
  }
  return undefined;
}

/**
 * Builds an index of assistant tool calls for later tool_result arg resolution.
 */
function buildToolCallArgsIndex(records: ChatRecord[]): ToolCallArgsIndex {
  const byId = new Map<string, Record<string, unknown>>();
  const byName = new Map<string, Array<Record<string, unknown>>>();

  for (const record of records) {
    if (record.type !== 'assistant' || !record.message?.parts) continue;

    for (const part of record.message.parts) {
      if (!('functionCall' in part) || !part.functionCall?.name) continue;

      const normalizedArgs = normalizeFunctionCallArgs(part.functionCall.args);
      if (!normalizedArgs) continue;

      const toolName = part.functionCall.name;
      const callId =
        typeof part.functionCall.id === 'string' ? part.functionCall.id : null;

      if (callId) {
        byId.set(callId, normalizedArgs);
      }

      const queue = byName.get(toolName) ?? [];
      queue.push(normalizedArgs);
      byName.set(toolName, queue);
    }
  }

  return { byId, byName };
}

/**
 * Calculate file operation statistics from ChatRecords.
 * Uses toolCallResult from tool_result records for accurate statistics.
 */
function calculateFileStats(records: ChatRecord[]): FileOperationStats {
  const argsIndex = buildToolCallArgsIndex(records);
  const byNameCursor = new Map<string, number>();

  const stats: FileOperationStats = {
    filesWritten: 0,
    linesAdded: 0,
    linesRemoved: 0,
    writtenFilePaths: new Set(),
  };

  for (const record of records) {
    if (record.type !== 'tool_result' || !record.toolCallResult) continue;

    const toolName = extractToolNameFromRecord(record);
    const callId =
      record.toolCallResult.callId ?? extractFunctionResponseId(record);
    const argsFromId =
      callId && argsIndex.byId.has(callId)
        ? argsIndex.byId.get(callId)
        : undefined;
    let args = argsFromId;
    if (!args && toolName) {
      const queue = argsIndex.byName.get(toolName);
      if (queue && queue.length > 0) {
        const cursor = byNameCursor.get(toolName) ?? 0;
        args = queue[cursor];
        byNameCursor.set(toolName, cursor + 1);
      }
    }
    const { resultDisplay } = record.toolCallResult;

    // Track file locations from resultDisplay
    if (
      resultDisplay &&
      typeof resultDisplay === 'object' &&
      'fileName' in resultDisplay
    ) {
      const display = resultDisplay as {
        fileName: string;
        fileDiff?: string;
        originalContent?: string | null;
        newContent?: string;
        diffStat?: { model_added_lines?: number; model_removed_lines?: number };
      };

      // Determine operation type based on content fields
      const hasOriginalContent = 'originalContent' in display;
      const hasNewContent = 'newContent' in display;

      // For write/edit operations, use full path from args if available
      let filePath: string;
      if (typeof display.fileName === 'string') {
        // Prefer args.file_path for full path, fallback to fileName (which may be basename)
        filePath = (args?.['file_path'] as string) || display.fileName;
      } else {
        // Fallback if fileName is not a string
        filePath = 'unknown';
      }

      if (hasOriginalContent || hasNewContent) {
        // This is a write/edit operation
        stats.filesWritten++;
        stats.writtenFilePaths.add(filePath);

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
      }
    }
  }

  return stats;
}

/**
 * Extracts token usage from TaskResultDisplay executionSummary.
 */
function extractTaskToolTokens(record: ChatRecord): number {
  if (record.type !== 'tool_result' || !record.toolCallResult?.resultDisplay) {
    return 0;
  }

  const { resultDisplay } = record.toolCallResult;
  if (typeof resultDisplay !== 'object' || !('type' in resultDisplay)) {
    return 0;
  }

  const sumFromSummary = (summary: unknown): number => {
    if (!summary || typeof summary !== 'object') return 0;
    const s = summary as {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      thoughtTokens?: number;
      cachedTokens?: number;
    };
    if (typeof s.totalTokens === 'number') return s.totalTokens;
    return (
      (s.inputTokens ?? 0) +
      (s.outputTokens ?? 0) +
      (s.thoughtTokens ?? 0) +
      (s.cachedTokens ?? 0)
    );
  };

  if (
    resultDisplay.type === 'task_execution' &&
    'executionSummary' in resultDisplay
  ) {
    return sumFromSummary(resultDisplay.executionSummary);
  }

  // Batch: sum tokens across all child task executionSummaries.
  if (
    resultDisplay.type === 'task_execution_batch' &&
    'tasks' in resultDisplay
  ) {
    const tasks = (
      resultDisplay as { tasks?: Array<{ executionSummary?: unknown }> }
    ).tasks;
    if (Array.isArray(tasks)) {
      return tasks.reduce(
        (acc, t) => acc + sumFromSummary(t.executionSummary),
        0,
      );
    }
  }

  return 0;
}

/**
 * Calculate token statistics from ChatRecords.
 * Aggregates usageMetadata from assistant records and TaskTool executionSummary to get total token usage.
 * Uses the last assistant record that has both totalTokenCount and contextWindowSize for calculating context usage percent.
 */
function calculateTokenStats(records: ChatRecord[]): {
  totalTokens: number;
  contextUsagePercent?: number;
  contextWindowSize?: number;
} {
  let totalTokens = 0;
  // Track the last assistant record that has BOTH totalTokenCount and contextWindowSize
  // to ensure the percentage calculation uses values from the same record
  let lastValidRecord: {
    totalTokenCount: number;
    contextWindowSize: number;
  } | null = null;

  // Aggregate usageMetadata from all assistant records
  for (const record of records) {
    if (record.type === 'assistant') {
      if (record.usageMetadata) {
        totalTokens += record.usageMetadata.totalTokenCount ?? 0;
      }
      // Only update lastValidRecord when BOTH values are present in the same record
      if (
        record.usageMetadata?.totalTokenCount !== undefined &&
        record.contextWindowSize !== undefined
      ) {
        lastValidRecord = {
          totalTokenCount: record.usageMetadata.totalTokenCount,
          contextWindowSize: record.contextWindowSize,
        };
      }
    }

    // Include TaskTool token usage from executionSummary
    const taskTokens = extractTaskToolTokens(record);
    if (taskTokens > 0) {
      totalTokens += taskTokens;
    }
  }

  // Use last valid record's values for context usage calculation
  // This represents how much of the context window is being used by the total tokens
  if (lastValidRecord) {
    const percent =
      (lastValidRecord.totalTokenCount / lastValidRecord.contextWindowSize) *
      100;
    return {
      totalTokens,
      contextUsagePercent: Math.round(percent * 10) / 10,
      contextWindowSize: lastValidRecord.contextWindowSize,
    };
  }

  // Fallback: return the contextWindowSize from the last assistant record even if no valid pair found
  // (for display purposes only, without percentage)
  const lastAssistantRecord = [...records]
    .reverse()
    .find((r) => r.type === 'assistant' && r.contextWindowSize !== undefined);

  return {
    totalTokens,
    contextWindowSize: lastAssistantRecord?.contextWindowSize,
  };
}

/**
 * Extract session metadata from ChatRecords.
 */
async function extractMetadata(
  conversation: {
    sessionId: string;
    startTime: string;
    messages: ChatRecord[];
  },
  config: Config,
): Promise<ExportMetadata> {
  const { sessionId, startTime, messages } = conversation;

  // Extract basic info from the first record
  const firstRecord = messages[0];
  const cwd = firstRecord?.cwd ?? '';
  const gitBranch = firstRecord?.gitBranch;

  // Get git repository name
  let gitRepo: string | undefined;
  if (cwd) {
    const { getGitRepoName } = await import('@qwen-code/qwen-code-core');
    gitRepo = getGitRepoName(cwd);
  }

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

  // Calculate file stats from original ChatRecords
  const fileStats = calculateFileStats(messages);

  // Calculate token stats from original ChatRecords
  // contextWindowSize is retrieved from the last assistant record for accuracy
  const tokenStats = calculateTokenStats(messages);

  return {
    sessionId,
    startTime,
    exportTime: new Date().toISOString(),
    cwd,
    gitRepo,
    gitBranch,
    model,
    channel,
    promptCount,
    contextUsagePercent: tokenStats.contextUsagePercent,
    contextWindowSize: tokenStats.contextWindowSize,
    totalTokens: tokenStats.totalTokens,
    filesWritten: fileStats.writtenFilePaths.size,
    linesAdded: fileStats.linesAdded,
    linesRemoved: fileStats.linesRemoved,
    uniqueFiles: Array.from(fileStats.writtenFilePaths),
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
  const metadata = await extractMetadata(conversation, config);

  return {
    sessionId: conversation.sessionId,
    startTime: conversation.startTime,
    messages,
    metadata,
  };
}
